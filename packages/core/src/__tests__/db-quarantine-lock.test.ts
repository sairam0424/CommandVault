import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DatabaseIoError,
  DatabaseLockedError,
  DatabasePermissionError,
} from '../indexer/db-errors.js';
import { quarantineCorruptDatabase } from '../indexer/quarantine.js';
import {
  captureStderr,
  catchError,
  deadProcessId,
  fsError,
  PATIENT_WAIT_MS,
  makeTempDir,
  seedDatabase,
  snapshotDir,
  writeCorruptSet as writeCorruptDatabaseSet,
  type StderrCapture,
} from './db-open-helpers.js';
import { resetSeam, seam } from './db-fs-seam.js';

vi.mock('node:fs', async (importOriginal) => {
  const { withSeam } = await import('./db-fs-seam.js');
  return withSeam(await importOriginal<typeof import('node:fs')>());
});

describe('the quarantine lock', () => {
  let dir: string;
  let dbPath: string;
  let stderr: StderrCapture;

  beforeEach(() => {
    dir = makeTempDir('quarantine-lock');
    dbPath = join(dir, 'vault.db');
    stderr = captureStderr();
  });

  afterEach(() => {
    resetSeam();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function notices(): string[] {
    return stderr.lines().filter((line) => line.startsWith('CommandVault:'));
  }

  const writeCorruptSet = (): string | undefined => writeCorruptDatabaseSet(dbPath);

  const lockPath = (): string => `${dbPath}.quarantine.lock`;
  const SHORT_WAIT_MS = 60;
  const MINUTE_MS = 60_000;
  const HOLDER_REPAIR_MS = 200;
  const HOLDER_REPAIRED_CONTENT = 'repaired by the holder, so a different length';
  const HOLDER_SCRIPT = `
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    setTimeout(() => {
      fs.writeFileSync(workerData.dbPath, ${JSON.stringify(HOLDER_REPAIRED_CONTENT)});
      fs.unlinkSync(workerData.lockPath);
    }, workerData.repairedAfterMs);
  `;

  it('is held while the files are saved and emptied, and gone afterwards', () => {
    const fingerprint = writeCorruptSet();
    let heldDuringCopy = false;
    let holderDuringCopy: string | undefined;
    seam.beforeCopy = () => {
      heldDuringCopy = existsSync(lockPath());
      holderDuringCopy ??= heldDuringCopy ? readFileSync(lockPath(), 'utf8') : undefined;
    };

    const backup = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(backup).toBeDefined();
    expect(heldDuringCopy).toBe(true);
    // Without its holder's id an interrupted repair freezes the next opener for the whole age limit.
    expect(holderDuringCopy).toBe(`${process.pid}\n`);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('is released when the repair fails', () => {
    const fingerprint = writeCorruptSet();
    seam.beforeTruncate = (path) => {
      if (path === dbPath) throw fsError('EPERM', 'truncate');
    };

    expect(() => quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'))).toThrow(
      DatabasePermissionError,
    );

    expect(existsSync(lockPath())).toBe(false);
  });

  it.each([
    ['ENOSPC', DatabaseIoError],
    ['EIO', DatabaseIoError],
    ['EMFILE', DatabaseIoError],
    ['EROFS', DatabasePermissionError],
  ])(
    'is removed when its holder id cannot be written (%s), so the next opener does not wait for it',
    (code, expectedError) => {
      const fingerprint = writeCorruptSet();
      const before = snapshotDir(dir);
      seam.beforeWrite = (path) => {
        if (path === lockPath()) throw fsError(code, 'write');
      };

      expect(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      ).toThrow(expectedError);

      // An empty lock names nobody, so it would stay in the way until it had aged out.
      expect(existsSync(lockPath())).toBe(false);
      expect(snapshotDir(dir)).toEqual(before);
      delete seam.beforeWrite;

      // No process runs, so the retry gets the lock at once; the wait is far below the age limit.
      const backup = quarantineCorruptDatabase(
        dbPath,
        fingerprint,
        new Error('bad'),
        SHORT_WAIT_MS,
      );
      expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
      expect(existsSync(lockPath())).toBe(false);
    },
  );

  it('makes a second repair give up, changing nothing, while the first is still running', () => {
    const fingerprint = writeCorruptSet();
    writeFileSync(lockPath(), `${process.pid}\n`);
    const before = snapshotDir(dir);

    const failure = catchError(() =>
      quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
    );

    expect(failure).toBeInstanceOf(DatabaseLockedError);
    // The holder's lock is not ours to remove, and nothing else changed.
    expect(snapshotDir(dir)).toEqual(before);
    expect(notices()).toEqual([]);
  });

  function makeOld(path: string): void {
    const longAgo = new Date(Date.now() - MINUTE_MS);
    utimesSync(path, longAgo, longAgo);
  }

  it('is not taken over however old it is while its holder is alive, and the error names it', () => {
    const fingerprint = writeCorruptSet();
    // A repairer frozen inside its repair (SIGSTOP, a suspended VM) is slow, not gone: if it wakes
    // up after someone else repaired the file it would empty the new database.
    writeFileSync(lockPath(), `${process.pid}\n`);
    makeOld(lockPath());
    const before = snapshotDir(dir);

    const failure = catchError(() =>
      quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
    );

    expect(failure).toBeInstanceOf(DatabaseLockedError);
    // The holder's id may have been reused after a crash, so the way out must be in the message.
    expect((failure as Error).message).toContain(lockPath());
    expect(snapshotDir(dir)).toEqual(before);
    expect(notices()).toEqual([]);
  });

  it.each([
    ['has no id (its creator died before writing it)', ''],
    ['holds something that is not a process id', 'not-a-pid\n'],
    ['holds a negative number', '-4\n'],
  ])('is taken over once it is old and it %s', (_what, content) => {
    const fingerprint = writeCorruptSet();
    writeFileSync(lockPath(), content);
    makeOld(lockPath());

    const backup = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(backup).toBeDefined();
    expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('is taken over at once when the process that held it no longer exists', () => {
    const fingerprint = writeCorruptSet();
    // Killed inside a repair: the lock is fresh, so only the dead id says it is abandoned. The wait
    // is far shorter than the age limit, so waiting for the lock to age would give up instead.
    writeFileSync(lockPath(), `${deadProcessId()}\n`);

    const backup = quarantineCorruptDatabase(
      dbPath,
      fingerprint,
      new Error('bad'),
      PATIENT_WAIT_MS,
    );

    expect(backup).toBeDefined();
    expect(readFileSync(backup!, 'utf8')).toBe('corrupt');
    expect(existsSync(lockPath())).toBe(false);
  });

  it.each([
    ['has no id yet, its creator is still writing it', ''],
    ['holds something that is not a process id', 'not-a-pid\n'],
    ['holds a negative number', '-4\n'],
  ])('is not taken over while fresh and it %s', (_what, content) => {
    const fingerprint = writeCorruptSet();
    writeFileSync(lockPath(), content);
    const before = snapshotDir(dir);

    const failure = catchError(() =>
      quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
    );

    expect(failure).toBeInstanceOf(DatabaseLockedError);
    expect(snapshotDir(dir)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'is not taken over when its holder belongs to another user (kill reports EPERM, not ESRCH)',
    () => {
      const fingerprint = writeCorruptSet();
      writeFileSync(lockPath(), '1\n'); // init / launchd: always alive, never ours
      const before = snapshotDir(dir);

      const failure = catchError(() =>
        quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), SHORT_WAIT_MS),
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(snapshotDir(dir)).toEqual(before);
    },
  );

  it('waits for the holder of the lock, then finds the file repaired and does nothing more', async () => {
    const fingerprint = writeCorruptSet();
    writeFileSync(lockPath(), `${process.pid}\n`);
    // Another CommandVault process is repairing this file: it rewrites it, then drops the lock. It
    // runs on a thread of its own because this one is blocked while it waits.
    const holder = new Worker(HOLDER_SCRIPT, {
      eval: true,
      workerData: { dbPath, lockPath: lockPath(), repairedAfterMs: HOLDER_REPAIR_MS },
    });
    const startedAt = Date.now();

    const result = catchError(() =>
      quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad')),
    );
    const waitedMs = Date.now() - startedAt;
    await once(holder, 'exit');

    expect(result).toBeUndefined();
    expect(waitedMs).toBeGreaterThanOrEqual(HOLDER_REPAIR_MS);
    expect(readFileSync(dbPath, 'utf8')).toBe(HOLDER_REPAIRED_CONTENT);
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt.'))).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
    expect(notices()).toEqual([]);
  });

  it('finds the file already repaired once it gets the lock, and does nothing more', () => {
    const fingerprint = writeCorruptSet();
    // What a process that waited for the lock sees after the first repair finished.
    seedDatabase(join(dir, 'repaired.db'), { rows: 2 });
    rmSync(dbPath);
    renameSync(join(dir, 'repaired.db'), dbPath);
    const before = snapshotDir(dir);

    const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(result).toBeUndefined();
    expect(snapshotDir(dir)).toEqual(before);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });
});
