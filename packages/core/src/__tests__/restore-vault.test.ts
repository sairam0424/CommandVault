import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BackupRejectedError,
  backupVault,
  removeBackupFiles,
  restoreVault,
} from '../indexer/backup-restore.js';
import {
  DatabaseLockedError,
  DatabaseOpenError,
  DatabasePermissionError,
} from '../indexer/db-errors.js';
import { KNOWN_SCHEMA_VERSION } from '../indexer/migrations.js';
import { withRegisteredOpener } from '../indexer/quarantine-openers.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import {
  catchError,
  deadProcessId,
  fsError,
  makeTempDir,
  writeGarbage,
} from './db-open-helpers.js';
import { resetSeam, seam } from './db-fs-seam.js';
import { tableChecksums, withDatabase } from './migration-fixtures.js';
import { raceEntries, raceEntryId } from './reindex-race-support.js';
import {
  isWriterRunning,
  killHeldWriter,
  quickCheck,
  sha256,
  startHeldWriter,
  usageOf,
  type HeldWriter,
} from './backup-test-support.js';

vi.mock('node:fs', async (importOriginal) => {
  const { withSeam } = await import('./db-fs-seam.js');
  return withSeam(await importOriginal<typeof import('node:fs')>());
});

/**
 * `restore` used to copy the backup over vault.db while the live -wal and
 * -shm stayed beside it, so the next open replayed the stale log into the restored file; nothing
 * of the replaced database was kept, and nothing about the backup was checked. The invariant
 * under test: at every instant vault.db is the old content (its log folded in or saved as the
 * pre-restore copy) or the new content, and a refused backup changes nothing at all.
 */

const IS_WINDOWS = process.platform === 'win32';
const IS_ROOT = process.getuid?.() === 0;
const SHORT_WAIT_MS = 300;
const LONG_WAIT_MS = 40_000;
const BACKUP_USAGE = 7;
const HOT_COMMITS = 300;
const ENTRY_COUNT = 3;
const NEWER_VERSION = 99;
const BACKUP_NAME = 'vault-2026-01-01T00-00-00.db';
// A live process other than this one, standing for another CommandVault process.
const otherProcessId = process.ppid;

describe('restoreVault', () => {
  let dir: string;
  let home: string;
  let dbPath: string;
  let backups: string;
  let backup: string;
  let entryId: string;
  let writer: HeldWriter | undefined;

  beforeEach(async () => {
    dir = makeTempDir('restore');
    home = makeTempDir('restore-home');
    dbPath = join(dir, 'vault.db');
    backups = join(dir, 'backups');
    backup = join(backups, BACKUP_NAME);
    entryId = raceEntryId(0);
    mkdirSync(backups);
    const engine = await SqliteEngine.create(dbPath);
    try {
      engine.index(raceEntries(ENTRY_COUNT));
      for (let use = 0; use < BACKUP_USAGE; use += 1) engine.incrementUsage(entryId);
    } finally {
      engine.close();
    }
    await backupVault(dbPath, backup);
  });

  afterEach(async () => {
    resetSeam();
    vi.restoreAllMocks();
    if (writer !== undefined && isWriterRunning(writer)) await killHeldWriter(writer);
    writer = undefined;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const stages = (): string[] => readdirSync(dir).filter((name) => name.includes('.restore.'));
  const preRestores = (): string[] =>
    readdirSync(backups).filter((name) => name.startsWith('pre-restore-'));
  const sidecars = (): string[] => ['-wal', '-shm'].filter((s) => existsSync(dbPath + s));
  const quarantineCopies = (): string[] =>
    readdirSync(dir).filter((name) => name.includes('.corrupt.'));

  async function usageSeenByTheEngine(): Promise<number | undefined> {
    const engine = await SqliteEngine.create(dbPath);
    try {
      return engine.getEntry(entryId)?.usageCount;
    } finally {
      engine.close();
    }
  }

  async function leaveHotWal(): Promise<void> {
    writer = await startHeldWriter(dbPath, entryId, HOT_COMMITS, home);
    await killHeldWriter(writer);
    writer = undefined;
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
  }

  async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
    return run().then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  describe('the write-ahead log of the replaced database', () => {
    it(`folds a killed writer's ${HOT_COMMITS} commits into the pre-restore copy and installs the backup`, async () => {
      await leaveHotWal();

      const result = await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(sidecars()).toEqual([]);
      expect(stages()).toEqual([]);
      expect(result.info).toMatchObject({
        entries: ENTRY_COUNT,
        schemaVersion: KNOWN_SCHEMA_VERSION,
      });
      expect(usageOf(result.preRestore, entryId)).toBe(BACKUP_USAGE + HOT_COMMITS);
      expect(quickCheck(result.preRestore)).toBe('ok');
      expect(await usageSeenByTheEngine()).toBe(BACKUP_USAGE);
    });

    it('keeps the user tables of the replaced database exactly in the pre-restore copy', async () => {
      const before = tableChecksums(dbPath);

      const result = await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(tableChecksums(result.preRestore)).toEqual(before);
    });

    it('copies a database SQLite cannot open raw, with its hot -wal and -shm, then installs the backup', async () => {
      await leaveHotWal();
      const garbage = writeGarbage(dbPath);
      const wal = readFileSync(`${dbPath}-wal`);

      const result = await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(readFileSync(result.preRestore)).toEqual(garbage);
      // Buffer.equals: vitest's deep equality takes seconds on a log of this size.
      expect(readFileSync(`${result.preRestore}-wal`).equals(wal)).toBe(true);
      expect(existsSync(`${result.preRestore}-shm`)).toBe(true);
      // The damaged file was never opened read-write, so nothing repaired it in place.
      expect(quarantineCopies()).toEqual([]);
      expect(sidecars()).toEqual([]);
      // Without the unlink the stale log would be replayed into the restored file here.
      expect(await usageSeenByTheEngine()).toBe(BACKUP_USAGE);
    });
  });

  describe('a refused backup changes nothing', () => {
    const hostile: ReadonlyArray<[string, (path: string) => void]> = [
      ['random bytes', (path) => void writeGarbage(path)],
      ['an empty file', (path) => writeFileSync(path, '')],
      ['a truncated database', (path) => writeFileSync(path, readFileSync(path).subarray(0, 2000))],
      [
        'a database without entries',
        (path) => withDatabase(path, (db) => db.exec('DROP TABLE entries')),
      ],
      [
        'a database without schema_version',
        (path) => withDatabase(path, (db) => db.exec('DROP TABLE schema_version')),
      ],
      [
        'a database from a newer schema',
        (path) =>
          withDatabase(path, (db) => {
            db.prepare("INSERT INTO schema_version (version, description) VALUES (?, 'x')").run(
              NEWER_VERSION,
            );
            db.exec("DELETE FROM engine_meta WHERE key = 'compatible_from'");
          }),
      ],
    ];

    it.each(hostile)('%s: throws before anything exists', async (_name, damage) => {
      damage(backup);
      const liveSha = sha256(dbPath);
      // The read-only backup in beforeEach left empty sidecars; a refusal must add nothing to them.
      const sidecarsBefore = sidecars();

      const failure = await failureOf(() =>
        restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
      );

      expect(failure).toBeInstanceOf(BackupRejectedError);
      expect(sha256(dbPath)).toBe(liveSha);
      expect(preRestores()).toEqual([]);
      expect(stages()).toEqual([]);
      expect(sidecars()).toEqual(sidecarsBefore);
    });
  });

  describe('other connections', () => {
    it('refuses while another connection is inside a read transaction, and changes nothing', async () => {
      // The reader's snapshot has to include frames of the log: a reader positioned at an empty log
      // never blocks a checkpoint, and is as invisible as an idle connection.
      await leaveHotWal();
      const reader = new Database(dbPath);
      try {
        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) AS n FROM entries').get();

        const failure = await failureOf(() =>
          restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
        );

        expect(failure).toBeInstanceOf(DatabaseLockedError);
        expect((failure as Error).message).toContain('reading the database');
        // A blocked checkpoint still folds the frames up to the reader's mark into the file, so
        // the bytes move; the content, the thing a restore replaces, does not.
        expect(quickCheck(dbPath)).toBe('ok');
        expect(preRestores()).toEqual([]);
        expect(stages()).toEqual([]);
        reader.exec('COMMIT');
      } finally {
        reader.close();
      }
      expect(usageOf(dbPath, entryId)).toBe(BACKUP_USAGE + HOT_COMMITS);
    });

    // POSIX can replace a file another process holds open; Windows cannot unlink it (EBUSY).
    const onWindows = process.platform === 'win32';

    it.skipIf(onWindows)(
      'cannot see an idle connection and proceeds (the residual risk the module names)',
      async () => {
        const idle = new Database(dbPath);
        idle.prepare('SELECT count(*) AS n FROM entries').get();
        try {
          const result = await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });
          expect(existsSync(result.preRestore)).toBe(true);
        } finally {
          idle.close();
        }
        expect(await usageSeenByTheEngine()).toBe(BACKUP_USAGE);
      },
    );

    it.runIf(onWindows)(
      'refuses with a locked-database error while another connection holds the files open',
      async () => {
        const idle = new Database(dbPath);
        idle.prepare('SELECT count(*) AS n FROM entries').get();
        try {
          await expect(
            restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
          ).rejects.toBeInstanceOf(DatabaseLockedError);
        } finally {
          idle.close();
        }
      },
    );
  });

  describe('the repair lock', () => {
    let lockPath: string;

    beforeEach(() => {
      lockPath = `${dbPath}.quarantine.lock`;
    });

    /** Stands in for the process that holds the lock finishing: the lock goes when it is looked at. */
    function releaseLockWhenLookedAt(): void {
      const realKill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === otherProcessId && existsSync(lockPath)) rmSync(lockPath);
        return realKill(pid, signal);
      }) as typeof process.kill);
    }

    it('waits for a repair another process is running, then restores', async () => {
      writeFileSync(lockPath, `${otherProcessId}\n`, { flag: 'wx' });
      releaseLockWhenLookedAt();

      const result = await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(existsSync(result.preRestore)).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it(
      'gives up with DatabaseLockedError when a live process keeps the lock, and changes nothing',
      async () => {
        writeFileSync(lockPath, `${otherProcessId}\n`, { flag: 'wx' });
        const liveSha = sha256(dbPath);

        const failure = await failureOf(() =>
          restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
        );

        expect(failure).toBeInstanceOf(DatabaseLockedError);
        expect(sha256(dbPath)).toBe(liveSha);
        expect(preRestores()).toEqual([]);
        expect(stages()).toEqual([]);
        expect(existsSync(lockPath)).toBe(true);
      },
      LONG_WAIT_MS,
    );

    it('refuses what is not a lock file at the lock path, typed, and leaves no stage behind', async () => {
      mkdirSync(lockPath);
      const liveSha = sha256(dbPath);

      const failure = await failureOf(() =>
        restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
      );

      expect(failure).toBeInstanceOf(DatabaseOpenError);
      expect((failure as Error).message).toContain('is not a lock file');
      expect(sha256(dbPath)).toBe(liveSha);
      expect(stages()).toEqual([]);
      expect(preRestores()).toEqual([]);
    });

    it('takes over the lock of a repair that died', async () => {
      writeFileSync(lockPath, `${deadProcessId()}\n`);

      await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(existsSync(lockPath)).toBe(false);
    });

    it('blocks a CommandVault open for as long as the replacement runs', async () => {
      let blockedOpen: unknown;
      seam.beforeRename = (_from, to) => {
        if (to === dbPath) {
          blockedOpen = catchError(() =>
            withRegisteredOpener(dbPath, () => 'opened', SHORT_WAIT_MS),
          );
        }
      };

      await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(blockedOpen).toBeInstanceOf(DatabaseLockedError);
      expect(withRegisteredOpener(dbPath, () => 'opened', SHORT_WAIT_MS)).toBe('opened');
    });
  });

  describe('failure in the replacement itself', () => {
    it('EPERM at the rename: stage gone, live database intact, pre-restore kept and named', async () => {
      await leaveHotWal();
      seam.beforeRename = (_from, to) => {
        if (to === dbPath) throw fsError('EPERM', 'rename');
      };

      const failure = await failureOf(() =>
        restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
      );

      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(preRestores()).toHaveLength(1);
      expect((failure as Error).message).toContain(join(backups, preRestores()[0]!));
      expect(stages()).toEqual([]);
      expect(usageOf(dbPath, entryId)).toBe(BACKUP_USAGE + HOT_COMMITS);
      expect(quickCheck(dbPath)).toBe('ok');
    });

    it('EACCES unlinking the -wal: nothing is replaced', async () => {
      seam.beforeUnlink = (path) => {
        if (path === `${dbPath}-wal`) throw fsError('EACCES', 'unlink');
      };

      const failure = await failureOf(() =>
        restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
      );

      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(stages()).toEqual([]);
      expect(usageOf(dbPath, entryId)).toBe(BACKUP_USAGE);
    });

    it('a kill between unlink and rename leaves the checkpointed old file; the next run sweeps the stage', async () => {
      await leaveHotWal();
      seam.beforeRename = (_from, to) => {
        if (to === dbPath) throw new Error('killed here');
      };
      await failureOf(() => restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }));
      expect(usageOf(dbPath, entryId)).toBe(BACKUP_USAGE + HOT_COMMITS);
      expect(quickCheck(dbPath)).toBe('ok');
      // What a killed run leaves: its stage, under its own process id, and a sidecar of it.
      const stale = `${dbPath}.restore.${deadProcessId()}.tmp`;
      writeFileSync(stale, 'stale stage');
      writeFileSync(`${stale}-wal`, 'stale wal');
      const running = `${dbPath}.restore.${otherProcessId}.tmp`;
      writeFileSync(running, 'another restore in progress');
      resetSeam();

      await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });

      expect(existsSync(stale)).toBe(false);
      expect(existsSync(`${stale}-wal`)).toBe(false);
      expect(existsSync(running)).toBe(true);
      expect(await usageSeenByTheEngine()).toBe(BACKUP_USAGE);
    });

    it.skipIf(IS_WINDOWS || IS_ROOT)(
      'refuses when the data directory cannot be written to, and changes nothing',
      async () => {
        const liveSha = sha256(dbPath);
        chmodSync(dir, 0o500);

        const failure = await failureOf(() =>
          restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS }),
        );

        chmodSync(dir, 0o700);
        expect(failure).toBeInstanceOf(DatabasePermissionError);
        expect(sha256(dbPath)).toBe(liveSha);
        expect(stages()).toEqual([]);
        expect(preRestores()).toEqual([]);
      },
    );
  });

  it('keeps the newest three pre-restore copies', async () => {
    for (let round = 0; round < 4; round += 1) {
      await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });
    }

    expect(preRestores()).toHaveLength(3);
  });

  it('prunes the -wal and -shm of a raw pre-restore copy together with it', async () => {
    writeGarbage(dbPath);
    writeFileSync(`${dbPath}-wal`, 'hot wal frames');
    writeFileSync(`${dbPath}-shm`, 'wal index');
    const raw = await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });
    // The control: the raw copy kept both sidecars, so there is something to leave behind.
    expect(existsSync(`${raw.preRestore}-wal`)).toBe(true);
    expect(existsSync(`${raw.preRestore}-shm`)).toBe(true);

    for (let round = 0; round < 3; round += 1) {
      await restoreVault(dbPath, backup, { waitMs: SHORT_WAIT_MS });
    }

    expect(existsSync(raw.preRestore)).toBe(false);
    expect(existsSync(`${raw.preRestore}-wal`)).toBe(false);
    expect(existsSync(`${raw.preRestore}-shm`)).toBe(false);
    expect(preRestores()).toHaveLength(3);
  });

  it('removeBackupFiles takes a copy with its sidecars, and a missing file is no error', () => {
    const copy = join(backups, 'vault-2001-01-01T00-00-00.db');
    writeFileSync(copy, 'db');
    writeFileSync(`${copy}-wal`, 'wal');

    removeBackupFiles(copy);
    removeBackupFiles(copy);

    expect(readdirSync(backups).filter((name) => name.startsWith('vault-2001'))).toEqual([]);
    expect(existsSync(backup)).toBe(true);
  });
});
