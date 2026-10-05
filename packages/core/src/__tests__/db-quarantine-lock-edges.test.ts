import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BetterSqliteAdapter } from '../indexer/better-sqlite-adapter.js';
import {
  DatabaseLockedError,
  DatabaseOpenError,
  DatabasePermissionError,
} from '../indexer/db-errors.js';
import { quarantineCorruptDatabase } from '../indexer/quarantine.js';
import { repairLockExists } from '../indexer/quarantine-lock.js';
import {
  backupNames,
  captureStderr,
  catchError,
  deadProcessId,
  fsError,
  PATIENT_WAIT_MS,
  makeTempDir,
  seedDatabase,
  snapshotDir,
  writeCorruptSet as writeCorruptDatabaseSet,
  writeGarbage,
  type StderrCapture,
} from './db-open-helpers.js';
import { resetSeam, seam } from './db-fs-seam.js';

vi.mock('node:fs', async (importOriginal) => {
  const { withSeam } = await import('./db-fs-seam.js');
  return withSeam(await importOriginal<typeof import('node:fs')>());
});

const SHORT_WAIT_MS = 60;
const MINUTE_MS = 60_000;
// A loop that never ends blocks the very thread that would time it out, so every attempt to create
// the lock is counted and a runaway loop is cut short with an error of its own.
const RUNAWAY_ATTEMPTS = 1_000;
const CANNOT_SYMLINK = process.platform === 'win32';
const LOCK_NAME = 'vault.db.quarantine.lock';

describe('the quarantine lock at its edges', () => {
  let dir: string;
  let dbPath: string;
  let lockPath: string;
  let stderr: StderrCapture;
  let lockAttempts: number;

  beforeEach(() => {
    dir = makeTempDir('quarantine-edges');
    dbPath = join(dir, 'vault.db');
    lockPath = `${dbPath}.quarantine.lock`;
    stderr = captureStderr();
    lockAttempts = 0;
  });

  afterEach(() => {
    resetSeam();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeCorruptSet = (): string | undefined => writeCorruptDatabaseSet(dbPath);

  function notices(): string[] {
    return stderr.lines().filter((line) => line.startsWith('CommandVault:'));
  }

  /** `interfere` runs on each attempt; it can make the attempt report that the lock exists. */
  function countLockAttempts(interfere?: () => void): void {
    seam.beforeCreate = (path) => {
      if (path !== lockPath) return;
      lockAttempts += 1;
      if (lockAttempts > RUNAWAY_ATTEMPTS) throw new Error('the lock loop does not end');
      interfere?.();
    };
  }

  /** Every file but the ones made for the lock: a dangling link cannot be read, and is not data. */
  function snapshotWithoutLock(): Record<string, string> {
    return snapshotDir(dir, (name) => !name.startsWith(LOCK_NAME));
  }

  function leftovers(): string[] {
    return readdirSync(dir).filter((name) => name.includes('.stale.'));
  }

  describe('a lock path that holds something other than a lock file', () => {
    type Place = readonly [string, (lock: string) => void];
    const SYMLINK_PLACES: readonly Place[] = [
      ['a symlink to nothing', (lock) => symlinkSync('/nonexistent/target', lock)],
      ['a symlink to itself', (lock) => symlinkSync(lock, lock)],
      [
        'a symlink to a plain file',
        (lock) => {
          writeFileSync(`${lock}.target`, `${process.pid}\n`);
          symlinkSync(`${lock}.target`, lock);
        },
      ],
    ];
    const PLACES: readonly Place[] = [
      ['a folder', (lock) => mkdirSync(lock)],
      ...(CANNOT_SYMLINK ? [] : SYMLINK_PLACES),
    ];

    it.each(PLACES)('ends in a typed error at once when the lock path is %s', (_what, place) => {
      const fingerprint = writeCorruptSet();
      place(lockPath);
      countLockAttempts();
      const before = snapshotWithoutLock();

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseOpenError);
      expect(failure).not.toBeInstanceOf(DatabaseLockedError);
      expect((failure as Error).message).toContain(lockPath);
      expect((failure as Error).message).toMatch(/not a lock file/);
      expect((failure as Error).message).toMatch(/database not modified/i);
      // One try: there is nothing to wait for, so nothing to time out either.
      expect(lockAttempts).toBe(1);
      expect(snapshotWithoutLock()).toEqual(before);
      expect(leftovers()).toEqual([]);
      expect(notices()).toEqual([]);
    });

    it.skipIf(CANNOT_SYMLINK)(
      'ends an open of a corrupt vault in a typed error, and never touches the file',
      async () => {
        const garbage = writeGarbage(dbPath);
        symlinkSync('/nonexistent/target', lockPath);
        countLockAttempts();

        const failure = await BetterSqliteAdapter.create(dbPath).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(DatabaseOpenError);
        expect((failure as Error).message).toContain(lockPath);
        expect(readFileSync(dbPath).equals(garbage)).toBe(true);
        expect(backupNames(dir)).toEqual([]);
      },
    );

    it.skipIf(CANNOT_SYMLINK)(
      'does not make an open of a healthy vault wait for a link to a running process id',
      async () => {
        // Only a plain file is a lock. A link is in the way of a repair (see above), but an open
        // that needs no repair has nothing to wait for; following the link would stall it for the
        // whole wait and then fail it with DatabaseLockedError, as the process it names runs.
        const favorites = 4;
        seedDatabase(dbPath, { rows: favorites });
        writeFileSync(`${lockPath}.target`, `${process.pid}\n`);
        symlinkSync(`${lockPath}.target`, lockPath);
        expect(repairLockExists(dbPath)).toBe(false);

        const startedAt = Date.now();
        const adapter = await BetterSqliteAdapter.create(dbPath);
        const openedInMs = Date.now() - startedAt;

        expect(adapter.queryOne<{ c: number }>('SELECT count(*) AS c FROM favorites')?.c).toBe(
          favorites,
        );
        adapter.close();
        expect(openedInMs).toBeLessThan(PATIENT_WAIT_MS);
        expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
        expect(backupNames(dir)).toEqual([]);
        expect(notices()).toEqual([]);
      },
    );
  });

  describe('the time the lock is waited for', () => {
    it('is bounded when the lock can be neither created nor found', () => {
      const fingerprint = writeCorruptSet();
      // The name reports "taken" and nothing is there to judge: a lock removed again and again.
      countLockAttempts(() => {
        throw fsError('EEXIST', 'open');
      });

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect((failure as Error).message).toContain(lockPath);
      // It slept between attempts: a loop that spins makes thousands of them in this time.
      expect(lockAttempts).toBeLessThan(SHORT_WAIT_MS);
      expect(notices()).toEqual([]);
    });

    it('is bounded when an abandoned lock changes each time it is removed', () => {
      const fingerprint = writeCorruptSet();
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      // Something that touches files (a sync tool, an indexer) makes the lock a different file at
      // the moment it is set aside, so the removal always puts it back.
      let touch = 1_600_000_000;
      seam.beforeRename = (from) => {
        if (from === lockPath) utimesSync(lockPath, (touch += 1), touch);
      };
      countLockAttempts();

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(readFileSync(dbPath, 'utf8')).toBe('corrupt');
      expect(leftovers()).toEqual([]);
    });
  });

  describe('a lock set aside by a removal that was interrupted', () => {
    const asideName = (id: string): string => `${lockPath}.stale.${id}`;

    /** The clock a minute on: the lock file itself does not change. */
    function afterAMinute(): void {
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + MINUTE_MS);
    }

    it('is left behind when the process dies between the rename and the unlink, then swept', () => {
      // First repair: it finishes, but the lock it set aside cannot be unlinked, which is what a
      // kill between those two steps leaves behind.
      seam.beforeUnlink = (path) => {
        if (path.includes('.stale.')) throw fsError('EIO', 'unlink');
      };
      quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));
      seam.beforeUnlink = undefined;
      expect(leftovers()).toHaveLength(1);
      const [leftover] = leftovers();
      afterAMinute();

      quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));

      expect(leftovers()).toEqual([]);
      expect(existsSync(join(dir, leftover!))).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('is kept while it is young, as the process that set it aside may be about to unlink it', () => {
      writeFileSync(asideName('young'), `${process.pid}\n`);

      quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));

      expect(readdirSync(dir)).toContain('vault.db.quarantine.lock.stale.young');
    });

    it('is dated by the moment it was set aside, not by the age of the lock it was', () => {
      // A rename keeps the modification time of the lock it moves, and an abandoned lock is old
      // already: it would look stale the moment it is set aside, and could be swept from under the
      // process that is about to put it back or unlink it.
      writeFileSync(asideName('just-renamed'), `${process.pid}\n`);
      const longAgo = new Date(Date.now() - MINUTE_MS);
      utimesSync(asideName('just-renamed'), longAgo, longAgo);

      quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));

      expect(readdirSync(dir)).toContain('vault.db.quarantine.lock.stale.just-renamed');
    });

    it('is the only kind of file that is swept, and only beside this lock', () => {
      const bystanders = [
        'other.db.quarantine.lock.stale.old',
        'vault.db.quarantine.lock.keep',
        'vault.db.quarantine.lock.stale',
        'vault.db.corrupt.1.bak',
      ];
      for (const name of bystanders) writeFileSync(join(dir, name), 'not litter');
      writeFileSync(asideName('old'), `${process.pid}\n`);
      afterAMinute();

      quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));

      expect(existsSync(asideName('old'))).toBe(false);
      for (const name of bystanders)
        expect(readFileSync(join(dir, name), 'utf8')).toBe('not litter');
    });

    it('does not stop a repair or the rest of the sweep when one of them cannot be removed', () => {
      writeFileSync(asideName('old-a'), `${process.pid}\n`);
      writeFileSync(asideName('old-b'), `${process.pid}\n`);
      afterAMinute();
      // Whichever is listed first fails, so the result does not depend on the order of the listing.
      let refused = false;
      seam.beforeUnlink = (path) => {
        if (refused || !path.includes('.stale.')) return;
        refused = true;
        throw fsError('EPERM', 'unlink');
      };

      const backup = quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));

      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(leftovers()).toHaveLength(1);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('does not stop a repair when the sweep cannot list the folder', () => {
      // The sweep lists the folder first; the check for processes that are opening the file second.
      seam.beforeReaddir = (path) => {
        if (path !== dir) return;
        seam.beforeReaddir = undefined;
        throw fsError('EACCES', 'scandir');
      };

      const backup = quarantineCorruptDatabase(dbPath, writeCorruptSet(), new Error('bad'));

      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(existsSync(lockPath)).toBe(false);
    });

    it('changes nothing when the folder cannot be listed to see who is opening the file', () => {
      // Without the list the repair cannot tell that another process is opening the file, and
      // emptying the file under it loses that process's writes: refuse, nothing is lost.
      const fingerprint = writeCorruptSet();
      const before = snapshotDir(dir);
      seam.beforeReaddir = (path) => {
        if (path === dir) throw fsError('EACCES', 'scandir');
      };

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad')),
      );

      seam.beforeReaddir = undefined; // the checks below list the folder too
      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(backupNames(dir)).toEqual([]);
      expect(snapshotDir(dir)).toEqual(before);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('is not an error when the abandoned lock is already gone at the moment it is set aside', () => {
      // Another opener removed the same abandoned lock between this one judging it and moving it.
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from !== lockPath) return;
        seam.beforeRename = undefined;
        unlinkSync(lockPath);
      };

      const backup = quarantineCorruptDatabase(
        dbPath,
        writeCorruptSet(),
        new Error('bad'),
        PATIENT_WAIT_MS,
      );

      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(leftovers()).toEqual([]);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('is not an error for the process that set it aside when another one swept it first', () => {
      // A removal that stalls between its rename and its checks (a suspended VM) can find the lock
      // it set aside already swept away by an opener that came later.
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.afterRename = (from, to) => {
        if (from !== lockPath) return;
        seam.afterRename = undefined;
        unlinkSync(to);
      };

      const backup = quarantineCorruptDatabase(
        dbPath,
        writeCorruptSet(),
        new Error('bad'),
        PATIENT_WAIT_MS,
      );

      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(leftovers()).toEqual([]);
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
