import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseLockedError, DatabasePermissionError } from '../indexer/db-errors.js';
import { fileFingerprint, quarantineCorruptDatabase } from '../indexer/quarantine.js';
import {
  backupNames,
  captureStderr,
  catchError,
  deadProcessId,
  fsError,
  PATIENT_WAIT_MS,
  makeTempDir,
  snapshotDir,
} from './db-open-helpers.js';
import { resetSeam, seam } from './db-fs-seam.js';

vi.mock('node:fs', async (importOriginal) => {
  const { withSeam } = await import('./db-fs-seam.js');
  return withSeam(await importOriginal<typeof import('node:fs')>());
});

const SHORT_WAIT_MS = 150;
const MINUTE_MS = 60_000;

describe('quarantineCorruptDatabase: the lock is only ever taken from its abandoned owner', () => {
  let dir: string;
  let dbPath: string;
  let lockPath: string;
  // A live process other than this one, standing for another opener of the same vault.
  const otherOpenerId = process.ppid;

  beforeEach(() => {
    dir = makeTempDir('quarantine-takeover');
    dbPath = join(dir, 'vault.db');
    lockPath = `${dbPath}.quarantine.lock`;
    captureStderr();
  });

  afterEach(() => {
    resetSeam();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCorruptSet(): string | undefined {
    writeFileSync(dbPath, 'corrupt');
    writeFileSync(`${dbPath}-wal`, 'wal');
    writeFileSync(`${dbPath}-shm`, 'shm');
    return fileFingerprint(dbPath);
  }

  /** What another opener does when it wins a lock: a new file, holding its own id. */
  function takeLockAs(processId: number): void {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, `${processId}\n`, { flag: 'wx' });
  }

  function lockHolder(): string | undefined {
    return existsSync(lockPath) ? readFileSync(lockPath, 'utf8').trim() : undefined;
  }

  function leftovers(): string[] {
    return readdirSync(dir).filter((name) => name.includes('.stale.'));
  }

  /** Every file except the lock: the lock is expected to change hands, the rest must not change. */
  function snapshotWithoutLock(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(snapshotDir(dir)).filter(([name]) => !name.endsWith('.quarantine.lock')),
    );
  }

  function noteCopies(): string[] {
    const copied: string[] = [];
    seam.beforeCopy = (from) => copied.push(from);
    return copied;
  }

  describe('a waiter that judged an abandoned lock', () => {
    it('does not remove the fresh lock a live opener took while the old one was being judged', () => {
      const fingerprint = writeCorruptSet();
      const deadId = deadProcessId();
      writeFileSync(lockPath, `${deadId}\n`);
      const realKill = process.kill.bind(process);
      // The opener that wins the takeover acts right after this waiter read the dead id.
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid !== deadId) return realKill(pid, signal);
        takeLockAs(otherOpenerId);
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }) as typeof process.kill);
      const copied = noteCopies();
      const before = snapshotWithoutLock();

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(lockHolder()).toBe(String(otherOpenerId));
      expect(copied).toEqual([]);
      expect(leftovers()).toEqual([]);
      expect(snapshotWithoutLock()).toEqual(before);
    });

    it('reports a failure to move the abandoned lock aside, and changes nothing', () => {
      const fingerprint = writeCorruptSet();
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from === lockPath) throw fsError('EPERM', 'rename');
      };
      const copied = noteCopies();
      const before = snapshotDir(dir);

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(copied).toEqual([]);
      expect(snapshotDir(dir)).toEqual(before);
    });

    it('puts back a lock that was taken in the moment between judging and moving it aside', () => {
      const fingerprint = writeCorruptSet();
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from !== lockPath) return;
        seam.beforeRename = undefined;
        takeLockAs(otherOpenerId);
      };
      const copied = noteCopies();

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(lockHolder()).toBe(String(otherOpenerId));
      expect(copied).toEqual([]);
      expect(leftovers()).toEqual([]);
    });

    it('does not overwrite a newer lock while putting the one it moved aside back', () => {
      const fingerprint = writeCorruptSet();
      const thirdOpenerId = process.pid; // alive, so its lock is not abandoned either
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from !== lockPath) return;
        seam.beforeRename = undefined;
        takeLockAs(otherOpenerId);
      };
      // Between the move and the put-back, a third opener creates a lock on the free name.
      seam.afterRename = (from) => {
        if (from !== lockPath) return;
        seam.afterRename = undefined;
        writeFileSync(lockPath, `${thirdOpenerId}\n`, { flag: 'wx' });
      };

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(lockHolder()).toBe(String(thirdOpenerId));
      expect(leftovers()).toEqual([]);
    });

    it('reports a failure to put a lock back that is not a name clash, and repairs nothing', () => {
      // EEXIST (a newer lock holds the name) and ENOENT (another opener swept the lock away) are
      // expected outcomes of the put-back. Anything else, like a file system that refuses hard
      // links, means it could not be put back, and carrying on would repair under a lost lock.
      const fingerprint = writeCorruptSet();
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from !== lockPath) return;
        seam.beforeRename = undefined;
        takeLockAs(otherOpenerId);
      };
      seam.beforeLink = (_existing, next) => {
        if (next === lockPath) throw fsError('EPERM', 'link');
      };
      const copied = noteCopies();
      const before = snapshotWithoutLock();

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), PATIENT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe('EPERM');
      expect(copied).toEqual([]);
      expect(backupNames(dir)).toEqual([]);
      expect(snapshotWithoutLock()).toEqual(before);
      expect(leftovers()).toEqual([]);
    });

    it('takes the abandoned lock over, and leaves nothing behind', () => {
      const fingerprint = writeCorruptSet();
      writeFileSync(lockPath, `${deadProcessId()}\n`);

      const backup = quarantineCorruptDatabase(
        dbPath,
        fingerprint,
        new Error('bad'),
        PATIENT_WAIT_MS,
      );

      expect(backup).toBeDefined();
      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(existsSync(lockPath)).toBe(false);
      expect(leftovers()).toEqual([]);
    });
  });

  describe('a repairer whose lock was taken from it', () => {
    // What happens to a repair that takes longer than the stale limit, or whose lock was moved
    // aside by a waiter that judged an earlier lock: another opener owns the lock now.
    function loseLockDuringCopy(): void {
      seam.beforeCopy = (from) => {
        if (from !== dbPath) return;
        seam.beforeCopy = undefined;
        takeLockAs(otherOpenerId);
      };
    }

    it('does not delete or empty anything, and leaves no copies', () => {
      const fingerprint = writeCorruptSet();
      const before = snapshotWithoutLock();
      loseLockDuringCopy();

      const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

      expect(result).toBeUndefined();
      expect(backupNames(dir)).toEqual([]);
      expect(snapshotWithoutLock()).toEqual(before);
    });

    it('does not remove the lock of the opener that took it', () => {
      const fingerprint = writeCorruptSet();
      loseLockDuringCopy();

      quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

      expect(lockHolder()).toBe(String(otherOpenerId));
      expect(leftovers()).toEqual([]);
    });
  });

  describe('a file that changes while it is being copied', () => {
    it('is left to whoever changed it when it was truncated, with no error and no short copy', () => {
      const fingerprint = writeCorruptSet();
      // The repair of another opener empties the file while this one is copying it. (fs.copyFileSync
      // spins forever in that situation on macOS, which is why it is not used.)
      seam.beforeRead = (from) => {
        if (from !== dbPath) return;
        seam.beforeRead = undefined;
        truncateSync(dbPath, 0);
      };

      const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

      expect(result).toBeUndefined();
      expect(backupNames(dir)).toEqual([]);
      expect(leftovers()).toEqual([]);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('keeps a write-ahead log that grew while it was being copied, instead of deleting it', () => {
      const fingerprint = writeCorruptSet();
      // The frames appended after the copy began are in no backup, and deleting the log loses them.
      seam.beforeRead = (from) => {
        if (from !== `${dbPath}-wal`) return;
        seam.beforeRead = undefined;
        appendFileSync(`${dbPath}-wal`, 'frames written meanwhile');
      };

      const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

      expect(result).toBeUndefined();
      expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('walframes written meanwhile');
      expect(readFileSync(dbPath, 'utf8')).toBe('corrupt');
      expect(backupNames(dir)).toEqual([]);
    });
  });

  describe('a sidecar whose original goes away during the copy', () => {
    // SQLite, in another opener, deleted the -wal and folded it into the database file.
    function vanishAt(hook: 'afterCopy' | 'beforeRead', path: string): void {
      seam[hook] = (reached) => {
        if (!reached.endsWith(path)) return;
        seam[hook] = undefined;
        unlinkSync(`${dbPath}-wal`);
        appendFileSync(dbPath, '+');
      };
    }

    it.each([
      ['once it was copied', 'afterCopy', '.bak-wal'],
      ['while it is being read', 'beforeRead', '-wal'],
    ] as const)(
      'leaves no copy of it behind when it goes away %s and the database file then changed',
      (_when, hook, path) => {
        const fingerprint = writeCorruptSet();
        vanishAt(hook, path);

        const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

        expect(result).toBeUndefined();
        expect(backupNames(dir)).toEqual([]);
        expect(readdirSync(dir).sort()).toEqual(['vault.db', 'vault.db-shm']);
        expect(readFileSync(dbPath, 'utf8')).toBe('corrupt+');
      },
    );
  });

  describe('a repairer that is stalled while it holds the lock', () => {
    it('is not robbed by an opener that arrives after the stale limit, and empties nothing twice', () => {
      const fingerprint = writeCorruptSet();
      let secondOpener: unknown = 'did not run';
      let databaseWhileStalled: string | undefined;
      // The holder is frozen (SIGSTOP, a suspended VM) just before it empties the file, for longer
      // than the stale limit; a second opener of the same corrupt file arrives meanwhile.
      seam.beforeTruncate = (path) => {
        if (path !== dbPath) return;
        seam.beforeTruncate = undefined;
        // The clock moves on by a minute; the lock file itself does not change.
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + MINUTE_MS);
        try {
          secondOpener = catchError(() =>
            quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
          );
        } finally {
          clock.mockRestore();
        }
        databaseWhileStalled = readFileSync(dbPath, 'utf8');
      };

      const backup = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

      // Had the second opener taken the lock it would have emptied the file, opened a new database
      // and acknowledged writes into it, which the holder then truncates when it resumes.
      expect(secondOpener).toBeInstanceOf(DatabaseLockedError);
      expect(databaseWhileStalled).toBe('corrupt');
      // One repair, one backup: a second repair would have made a second one.
      expect(backupNames(dir).filter((name) => name.endsWith('.bak'))).toEqual([basename(backup!)]);
      expect(readFileSync(dbPath)).toHaveLength(0);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe('the lock the repair itself writes', () => {
    function fsError(code: string): Error {
      return Object.assign(new Error(`${code}: simulated failure`), { code });
    }

    it('names its holder, so the leftover of a repair that was killed is taken over at once', () => {
      // First repair: it finishes, but its lock cannot be removed, which is what a kill while
      // cleaning up leaves behind. Only the lock the code wrote itself is used from here on.
      seam.beforeRename = (from) => {
        if (from === lockPath) throw fsError('EIO');
      };
      quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'), SHORT_WAIT_MS);
      seam.beforeRename = undefined;
      expect(existsSync(lockPath)).toBe(true);
      // That process is gone (kill(2) with signal 0 says ESRCH for its id).
      const realKill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid !== process.pid || signal !== 0) return realKill(pid, signal);
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }) as typeof process.kill);

      // Far shorter than the age limit: waiting for the lock to age would give up instead.
      const backup = quarantineCorruptDatabase(
        dbPath,
        writeCorruptSet(),
        new Error('bad'),
        PATIENT_WAIT_MS,
      );

      expect(backup).toBeDefined();
      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
