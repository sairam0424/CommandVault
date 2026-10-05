import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseLockedError, DatabaseOpenError, errorCode } from './db-errors.js';
import {
  createExclusive,
  fileFingerprint,
  fingerprintOf,
  isProcessRunning,
  orWhenMissing,
  sleepSync,
} from './quarantine-fs.js';

const QUARANTINE_LOCK_SUFFIX = '.quarantine.lock';
export const QUARANTINE_LOCK_WAIT_MS = 15_000;
const QUARANTINE_LOCK_POLL_MS = 10;
// A repair takes milliseconds, so a lock that names no process and is older than this was left by
// one that died before it wrote its id. A lock that names a running process is never this old.
const QUARANTINE_LOCK_STALE_MS = 10_000;
const SET_ASIDE_INFIX = '.stale.';

/** Writes our id into the lock `fd` and closes it; the fingerprint of the lock as written. */
function nameHolder(fd: number): string {
  try {
    writeFileSync(fd, `${process.pid}\n`);
    return fingerprintOf(fstatSync(fd, { bigint: true }));
  } finally {
    closeSync(fd);
  }
}

/**
 * Exclusive-creates the lock with our id inside; its fingerprint, or undefined if one exists.
 * A lock whose id could not be written is removed again: it names nobody, so the next opener would
 * wait until it had aged out although no process runs.
 */
function createLockFile(lockPath: string): string | undefined {
  const fd = createExclusive(lockPath);
  if (fd === undefined) return undefined;
  try {
    return nameHolder(fd);
  } catch (error) {
    bestEffort(() => unlinkSync(lockPath));
    throw error;
  }
}

type HolderState = 'running' | 'gone' | 'unnamed';

/** Whether the process the lock names runs; 'unnamed' when the lock holds no process id (yet). */
function holderState(lockPath: string): HolderState {
  const pid = orWhenMissing(0, () => Number(readFileSync(lockPath, 'utf8').trim()));
  if (!Number.isInteger(pid) || pid <= 0) return 'unnamed';
  return isProcessRunning(pid) ? 'running' : 'gone';
}

/**
 * Whether a lock looks abandoned, with the fingerprint of the file judged. Undefined: no lock.
 * A running holder is slow, not gone, however old its lock: a repairer frozen inside its repair
 * (SIGSTOP, a suspended VM) would otherwise empty a database that was repaired and written to in
 * the meantime. So age only counts for a lock that names nobody, whose creator died before writing.
 */
function judgeLock(lockPath: string): { fingerprint: string; abandoned: boolean } | undefined {
  const stats = orWhenMissing(undefined, () => statSync(lockPath, { bigint: true }));
  if (stats === undefined) return undefined;
  const holder = holderState(lockPath);
  const isOld = Date.now() - Number(stats.mtimeMs) > QUARANTINE_LOCK_STALE_MS;
  const abandoned = holder === 'gone' || (holder === 'unnamed' && isOld);
  return { fingerprint: fingerprintOf(stats), abandoned };
}

/**
 * Removes the lock only if it is still the file with `fingerprint`. It is renamed away first, as
 * only a rename lets exactly one process win. A lock taken after `fingerprint` was read goes back
 * (never over a newer one); its owner then sees it lost the lock, see `stillHoldsLock`.
 */
function removeLockIfUnchanged(lockPath: string, fingerprint: string): void {
  const aside = `${lockPath}${SET_ASIDE_INFIX}${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try {
    if (fileFingerprint(aside) !== fingerprint) linkSync(aside, lockPath);
  } catch (error) {
    // EEXIST: a newer lock holds the name and stays. ENOENT: a later opener swept this one away.
    if (!['EEXIST', 'ENOENT'].includes(errorCode(error) ?? '')) throw error;
  } finally {
    orWhenMissing(undefined, () => unlinkSync(aside));
  }
}

/** Runs a step whose failure must not stop a repair; it is skipped. */
function bestEffort(step: () => void): void {
  try {
    step();
  } catch {
    // The step only tidies up. Its failure leaves litter behind, never a wrong outcome.
  }
}

function removeIfStale(path: string): void {
  const stats = orWhenMissing(undefined, () => lstatSync(path));
  // ctime, not mtime: a rename updates it, so it dates the moment the lock was set aside. The
  // modification time is the lock's own, and an abandoned lock is old before it is set aside.
  if (stats !== undefined && Date.now() - stats.ctimeMs > QUARANTINE_LOCK_STALE_MS) {
    unlinkSync(path);
  }
}

/**
 * Deletes the locks that removeLockIfUnchanged set aside and never got to unlink, because its
 * process was killed between the two steps. Only old ones: a young one may be about to be put back.
 */
function sweepSetAsideLocks(lockPath: string): void {
  bestEffort(() => {
    const folder = dirname(lockPath);
    const prefix = `${basename(lockPath)}${SET_ASIDE_INFIX}`;
    for (const name of readdirSync(folder)) {
      if (name.startsWith(prefix)) bestEffort(() => removeIfStale(join(folder, name)));
    }
  });
}

/** The holder's id can be reused after a crash, so the way out is in the message. */
function heldLockError(dbPath: string, lockPath: string): DatabaseLockedError {
  return new DatabaseLockedError(
    dbPath,
    new Error(
      `a repair of this file holds ${lockPath}; ` +
        'if no CommandVault process is running, delete that file',
    ),
  );
}

/**
 * The lock is a plain file this module creates. Anything else at its path (a folder, a symlink,
 * even one to nothing) is in the way, and waiting cannot change that: fail at once, say why.
 */
function assertIsLockFile(dbPath: string, lockPath: string): void {
  const inPlace = orWhenMissing(undefined, () => lstatSync(lockPath));
  if (inPlace === undefined || inPlace.isFile()) return;
  throw new DatabaseOpenError(
    `Cannot repair ${dbPath}: ${lockPath} is in the way and is not a lock file (a folder or a ` +
      'symlink, for example). Database not modified. Delete it, then try again.',
    dbPath,
  );
}

/** Creates the lock, waiting for its holder; gives up after `waitMs`. Returns its fingerprint. */
function acquireQuarantineLock(dbPath: string, lockPath: string, waitMs: number): string {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const created = createLockFile(lockPath);
    if (created !== undefined) return created;
    assertIsLockFile(dbPath, lockPath);
    const seen = judgeLock(lockPath);
    // Time bounds every way round, whatever the lock looks like: one that vanishes before it can be
    // judged, or one that is removed and comes back, makes no progress for the loop to rely on.
    if (Date.now() >= deadline) throw heldLockError(dbPath, lockPath);
    if (seen?.abandoned) removeLockIfUnchanged(lockPath, seen.fingerprint);
    else sleepSync(QUARANTINE_LOCK_POLL_MS);
  }
}

/** Whether a lock file is in place: a repair is under way, or died without removing its lock. */
export function repairLockExists(dbPath: string): boolean {
  return (
    orWhenMissing(undefined, () => lstatSync(dbPath + QUARANTINE_LOCK_SUFFIX))?.isFile() === true
  );
}

/**
 * Waits until no repair of `dbPath` holds the lock, or until `deadline` (epoch ms). A lock whose
 * holder has died is removed, so it does not outlive the crash that left it.
 */
export function waitForRepairToEnd(dbPath: string, deadline: number): void {
  const lockPath = dbPath + QUARANTINE_LOCK_SUFFIX;
  while (repairLockExists(dbPath)) {
    if (Date.now() >= deadline) throw heldLockError(dbPath, lockPath);
    const seen = judgeLock(lockPath);
    if (seen?.abandoned) removeLockIfUnchanged(lockPath, seen.fingerprint);
    else if (seen !== undefined) sleepSync(QUARANTINE_LOCK_POLL_MS);
  }
}

/**
 * Serialises repairs of one vault.db across processes: the second opener of a corrupt file must
 * find the first one's result. `run` can ask whether the lock is still its own.
 */
export function withQuarantineLock<T>(
  dbPath: string,
  waitMs: number,
  run: (owns: () => boolean) => T,
): T {
  const lockPath = dbPath + QUARANTINE_LOCK_SUFFIX;
  const held = acquireQuarantineLock(dbPath, lockPath, waitMs);
  try {
    sweepSetAsideLocks(lockPath);
    return run(() => fileFingerprint(lockPath) === held);
  } finally {
    try {
      removeLockIfUnchanged(lockPath, held);
    } catch {
      // The repair's outcome stands. A lock left behind names this process: later openers take it
      // over once the process is gone, or are told to delete it (see heldLockError).
    }
  }
}
