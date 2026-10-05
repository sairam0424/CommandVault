import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  DatabaseIoError,
  DatabaseOpenError,
  describeCause,
  errorMessage,
  toOpenError,
} from './db-errors.js';
import { QUARANTINE_LOCK_WAIT_MS, withQuarantineLock } from './quarantine-lock.js';
import { waitForOpeners } from './quarantine-openers.js';
import {
  OWNER_ONLY_MODE,
  createExclusive,
  fileFingerprint,
  orWhenMissing,
} from './quarantine-fs.js';

// The identity a caller takes before it opens a file, and hands back to say which file failed.
export { fileFingerprint };

const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
const MAX_BACKUP_NAME_ATTEMPTS = 100;

function sidecarsFree(backupPath: string): boolean {
  return SIDECAR_SUFFIXES.every((suffix) => fileFingerprint(backupPath + suffix) === undefined);
}

/** Claims a backup name with exclusive create so an earlier backup is never overwritten. */
function reserveBackupPath(dbPath: string): string {
  const stamp = Date.now();
  for (let attempt = 0; attempt < MAX_BACKUP_NAME_ATTEMPTS; attempt += 1) {
    const counter = attempt === 0 ? '' : `-${attempt}`;
    const candidate = `${dbPath}.corrupt.${stamp}${counter}.bak`;
    const fd = sidecarsFree(candidate) ? createExclusive(candidate) : undefined;
    if (fd === undefined) continue;
    closeSync(fd);
    return candidate;
  }
  throw new DatabaseIoError(
    dbPath,
    new Error(`no free backup name after ${MAX_BACKUP_NAME_ATTEMPTS} attempts`),
  );
}

type CopyOutcome = 'copied' | 'missing' | 'changed';

/**
 * Copies `from` to `to` (owner-only), checks the copy is complete and flushes it. 'changed': the
 * file was truncated or extended before it was read. Read into memory, not fs.copyFileSync: on
 * macOS that spins forever inside the call when its source is truncated meanwhile, as a repair in
 * another process does. `onCreated` runs once `to` exists, so the caller can delete it on failure.
 */
function copyDurably(
  from: string,
  to: string,
  flag: 'w' | 'wx',
  onCreated: () => void,
): CopyOutcome {
  const source = orWhenMissing(undefined, () => openSync(from, 'r'));
  if (source === undefined) return 'missing';
  try {
    const size = fstatSync(source).size;
    const content = readFileSync(source);
    if (content.length !== size) return 'changed';
    const target = openSync(to, flag, OWNER_ONLY_MODE);
    try {
      onCreated();
      writeFileSync(target, content);
      fsyncSync(target);
      if (fstatSync(target).size !== size) throw new Error(`copy of ${from} is incomplete`);
    } finally {
      closeSync(target);
    }
    return 'copied';
  } finally {
    closeSync(source);
  }
}

/**
 * The corrupt database and its sidecars, saved under one backup name before anything is touched.
 * The database file is never renamed: SQLite finds a connection's -wal, -shm and -journal by path
 * and locks per file, so a connection opened on the old file would mix up the new file's files.
 */
class SavedFiles {
  // The reserved backup name exists from the start; a sidecar copy is added once it is created.
  private readonly createdSuffixes = new Set<string>(['']);
  private readonly removedSuffixes: string[] = [];

  constructor(
    private readonly dbPath: string,
    private readonly backupPath: string,
  ) {}

  /** Copies the sidecars, then the database. False when a file changed or the database is gone. */
  copyAll(): boolean {
    for (const suffix of SIDECAR_SUFFIXES) {
      if (this.copy(suffix, 'wx') === 'changed') return false;
    }
    return this.copy('', 'w') === 'copied'; // the reserved backup name is ours to overwrite
  }

  private copy(suffix: string, flag: 'w' | 'wx'): CopyOutcome {
    const onCreated = (): void => void this.createdSuffixes.add(suffix);
    return copyDurably(this.dbPath + suffix, this.backupPath + suffix, flag, onCreated);
  }

  /**
   * Deletes the sidecars (a stale -wal or -journal would be replayed into the new database), then
   * empties the database file in place, so it keeps its inode and every connection agrees on it.
   */
  empty(): void {
    for (const suffix of SIDECAR_SUFFIXES.filter((one) => this.createdSuffixes.has(one))) {
      orWhenMissing(undefined, () => unlinkSync(this.dbPath + suffix));
      this.removedSuffixes.push(suffix);
    }
    chmodSync(this.dbPath, OWNER_ONLY_MODE);
    truncateSync(this.dbPath, 0);
  }

  /** Removes the copies; only when the originals are untouched or back in place. */
  discard(): void {
    for (const suffix of this.createdSuffixes) {
      try {
        unlinkSync(this.backupPath + suffix);
      } catch {
        // A leftover duplicate of an untouched file must not hide the real outcome.
      }
    }
  }

  /** Puts back what was deleted. Returns the error to report: `cause`, or what is left stranded. */
  rollBack(cause: unknown): unknown {
    const stranded: string[] = [];
    for (const suffix of this.removedSuffixes) {
      try {
        copyFileSync(this.backupPath + suffix, this.dbPath + suffix, constants.COPYFILE_EXCL);
      } catch (error) {
        const why = errorMessage(error);
        stranded.push(`${this.dbPath + suffix} is saved as ${this.backupPath + suffix} (${why})`);
      }
    }
    if (stranded.length === 0) {
      this.discard();
      return cause;
    }
    return new DatabaseOpenError(
      `Could not finish repairing ${this.dbPath} (${describeCause(cause)}) and could not undo it: ` +
        `${stranded.join('; ')}. Nothing was deleted; copy the saved files back to restore the ` +
        'database as it was, then try again.',
      this.dbPath,
      cause,
    );
  }
}

/**
 * All or nothing. True when the files are saved under `backupPath` and the database file is empty.
 * False, with nothing changed, when the file is gone, is no longer the one that failed (another
 * process repaired it) or the lock was taken from us. Throws after undoing a part-way failure.
 */
function saveAndEmpty(
  dbPath: string,
  backupPath: string,
  failedFingerprint: string,
  stillHoldsLock: () => boolean,
): boolean {
  const saved = new SavedFiles(dbPath, backupPath);
  try {
    // Checked after the copy: a process that ignores the lock may have repaired the file meanwhile.
    if (!saved.copyAll() || fileFingerprint(dbPath) !== failedFingerprint || !stillHoldsLock()) {
      saved.discard();
      return false;
    }
    saved.empty();
    return true;
  } catch (error) {
    throw saved.rollBack(error);
  }
}

/**
 * Saves a database SQLite reported as corrupt (and its sidecars) under a backup name and empties
 * it in place; returns the backup path. Undefined, with nothing changed, when the file is no
 * longer the one that failed (`failedFingerprint`, taken before the open): another process
 * repaired it and the caller should open again. The caller must have closed its handle. With the
 * lock held it first waits for the other processes that are in the middle of opening the file,
 * see quarantine-openers.ts, and gives up with a DatabaseLockedError if they do not finish.
 */
export function quarantineCorruptDatabase(
  dbPath: string,
  failedFingerprint: string | undefined,
  cause: unknown,
  lockWaitMs: number = QUARANTINE_LOCK_WAIT_MS,
): string | undefined {
  let backupPath: string | undefined;
  try {
    backupPath = withQuarantineLock(dbPath, lockWaitMs, (stillHoldsLock) => {
      if (failedFingerprint === undefined) return undefined;
      waitForOpeners(dbPath, lockWaitMs);
      if (fileFingerprint(dbPath) !== failedFingerprint) return undefined;
      const reserved = reserveBackupPath(dbPath);
      const isDone = saveAndEmpty(dbPath, reserved, failedFingerprint, stillHoldsLock);
      return isDone ? reserved : undefined;
    });
  } catch (error) {
    throw toOpenError(error, dbPath);
  }
  if (backupPath === undefined) return undefined;
  process.stderr.write(
    `CommandVault: ${dbPath} is not a valid SQLite database (${errorMessage(cause)}). ` +
      `Its contents were saved to ${backupPath} (nothing was deleted) and a new empty database ` +
      'was created. Favorites, usage counts and tags are not in the new file; recover them from ' +
      'the backup.\n',
  );
  return backupPath;
}
