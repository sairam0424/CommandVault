import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationBackupError } from '../indexer/db-errors.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  CURRENT_VERSIONS,
  corruptTablePage,
  createBaseHealthyDatabase,
  createLegacyDatabase,
  createMaintainerShapedDatabase,
  engineMeta,
  recordedVersions,
  schemaObjects,
  tableChecksums,
  withReadonlyDatabase,
} from './migration-fixtures.js';

// Before a migration changes a database that already holds something, a consistent copy of it is
// written next to it. If that copy cannot be written, the migration does not happen.

const KEPT_BACKUPS = 3;
const BACKUP_DIR = 'backups';
const BACKUP_NAME = /^pre-migrate-v(\d+)-[0-9A-Za-z-]+\.db$/;

const scenario = vi.hoisted(() => ({
  backupDestinations: [] as string[],
  failBackup: undefined as 'at-once' | 'after-writing' | undefined,
  reportedPath: undefined as string | undefined,
  /** The mode of each copy the moment the adapter finished writing it, before the engine touches it. */
  modesAsWritten: [] as number[],
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter = await original.createDatabaseAdapter(...args);
      const observed = instrumentAdapter(adapter, {
        reportedPath: scenario.reportedPath,
      });
      return {
        ...observed,
        backupTo: (destination: string) => {
          scenario.backupDestinations.push(destination);
          if (scenario.failBackup === 'at-once') throw new Error('disk full');
          if (scenario.failBackup === 'after-writing') {
            writeFileSync(destination, 'half a database');
            throw new Error('disk full');
          }
          adapter.backupTo(destination);
          scenario.modesAsWritten.push(statSync(destination).mode & 0o777);
        },
      };
    },
  };
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface DatabaseData {
  readonly versions: number[];
  readonly objects: Array<[string, string]>;
  readonly checksums: Record<string, string>;
}

/** What is stored in a database, as opposed to the bytes of its file. */
function dataOf(path: string): DatabaseData {
  return {
    versions: recordedVersions(path),
    objects: [...schemaObjects(path).entries()].sort(([a], [b]) => a.localeCompare(b)),
    checksums: tableChecksums(path),
  };
}

function backupFiles(dir: string): string[] {
  const backupDir = join(dir, BACKUP_DIR);
  return existsSync(backupDir) ? readdirSync(backupDir).sort() : [];
}

describe('the backup taken before a migration', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-migration-backup-'));
    dbPath = join(tempDir, 'vault.db');
    scenario.backupDestinations = [];
    scenario.failBackup = undefined;
    scenario.reportedPath = undefined;
    scenario.modesAsWritten = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('is written next to the database, named after the version it was taken at', async () => {
    createMaintainerShapedDatabase(dbPath);

    (await SqliteEngine.create(dbPath)).close();

    const [name, ...others] = backupFiles(tempDir);
    expect(others).toEqual([]);
    expect(name).toMatch(BACKUP_NAME);
    expect(BACKUP_NAME.exec(name!)?.[1]).toBe('4');
  });

  it('opens, and holds the database exactly as it was before the migration', async () => {
    createLegacyDatabase(dbPath);
    const before = {
      versions: recordedVersions(dbPath),
      objects: [...schemaObjects(dbPath).entries()].sort(([a], [b]) => a.localeCompare(b)),
      checksums: tableChecksums(dbPath),
    };

    (await SqliteEngine.create(dbPath)).close();

    const [name] = backupFiles(tempDir);
    const backupPath = join(tempDir, BACKUP_DIR, name!);
    expect(recordedVersions(backupPath)).toEqual(before.versions);
    expect([...schemaObjects(backupPath).entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual(
      before.objects,
    );
    expect(tableChecksums(backupPath)).toEqual(before.checksums);
    expect(
      withReadonlyDatabase(backupPath, (db) => db.pragma('integrity_check', { simple: true })),
    ).toBe('ok');
  });

  it.skipIf(process.platform === 'win32')('is readable by its owner only', async () => {
    createMaintainerShapedDatabase(dbPath);

    (await SqliteEngine.create(dbPath)).close();

    const [name] = backupFiles(tempDir);
    expect(statSync(join(tempDir, BACKUP_DIR, name!)).mode & 0o777).toBe(0o600);
    expect(statSync(join(tempDir, BACKUP_DIR)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')(
    'is owner-only when the adapter finishes it, also in a folder other users can enter',
    async () => {
      createMaintainerShapedDatabase(dbPath);
      // What `vault backup` leaves behind: a folder made with the default mode.
      const backupDir = join(tempDir, BACKUP_DIR);
      mkdirSync(backupDir);
      chmodSync(backupDir, 0o755);

      (await SqliteEngine.create(dbPath)).close();

      expect(scenario.modesAsWritten).toEqual([0o600]);
    },
  );

  it('is not written for a brand-new database', async () => {
    (await SqliteEngine.create(dbPath)).close();

    expect(scenario.backupDestinations).toEqual([]);
    expect(existsSync(join(tempDir, BACKUP_DIR))).toBe(false);
  });

  it('is not written for a database that lives in memory', async () => {
    // The engine cannot open ':memory:' itself; a real file that reports that path stands in.
    createMaintainerShapedDatabase(dbPath);
    scenario.reportedPath = ':memory:';

    (await SqliteEngine.create(dbPath)).close();

    expect(scenario.backupDestinations).toEqual([]);
    expect(existsSync(join(tempDir, BACKUP_DIR))).toBe(false);
  });

  it('is not written when nothing is left to migrate', async () => {
    createMaintainerShapedDatabase(dbPath);
    (await SqliteEngine.create(dbPath)).close();
    scenario.backupDestinations = [];

    (await SqliteEngine.create(dbPath)).close();

    expect(scenario.backupDestinations).toEqual([]);
    expect(backupFiles(tempDir)).toHaveLength(1);
  });

  it('removes an unfinished backup that a crashed process left behind', async () => {
    createMaintainerShapedDatabase(dbPath);
    const backupDir = join(tempDir, BACKUP_DIR);
    mkdirSync(backupDir);
    const leftover = 'pre-migrate-v2-20200101T000000000Z-1.db.partial';
    writeFileSync(join(backupDir, leftover), 'half a database');

    (await SqliteEngine.create(dbPath)).close();

    const names = backupFiles(tempDir);
    expect(names).not.toContain(leftover);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(BACKUP_NAME);
  });

  it('removes the journal SQLite leaves beside an unfinished backup when the process is killed', async () => {
    createMaintainerShapedDatabase(dbPath);
    const backupDir = join(tempDir, BACKUP_DIR);
    mkdirSync(backupDir);
    const leftovers = [
      'pre-migrate-v4-20200101T000000000Z-1.db.partial',
      'pre-migrate-v4-20200101T000000000Z-1.db.partial-journal',
    ];
    for (const name of [...leftovers, 'notes.partial-journal']) {
      writeFileSync(join(backupDir, name), 'x');
    }

    (await SqliteEngine.create(dbPath)).close();

    const names = backupFiles(tempDir);
    for (const leftover of leftovers) expect(names).not.toContain(leftover);
    // Only what is named like a backup of ours is ours to remove.
    expect(names).toContain('notes.partial-journal');
    expect(names.filter((name) => BACKUP_NAME.test(name))).toHaveLength(1);
  });

  it('keeps the newest three and leaves other files in the folder alone', async () => {
    createMaintainerShapedDatabase(dbPath);
    const backupDir = join(tempDir, BACKUP_DIR);
    mkdirSync(backupDir);
    const older = [
      'pre-migrate-v1-20200101T000000000Z-1.db',
      'pre-migrate-v2-20210101T000000000Z-1.db',
      'pre-migrate-v3-20220101T000000000Z-1.db',
      'pre-migrate-v10-20230101T000000000Z-1.db',
    ];
    for (const name of [...older, 'pre-restore-20240101T000000000Z.db', 'notes.txt']) {
      writeFileSync(join(backupDir, name), 'x');
    }

    (await SqliteEngine.create(dbPath)).close();

    const remaining = backupFiles(tempDir);
    const migrateBackups = remaining.filter((name) => BACKUP_NAME.test(name));
    expect(migrateBackups).toHaveLength(KEPT_BACKUPS);
    // Newest by the time in the name: version 10 sorts before version 2 as text, but not here.
    expect(migrateBackups).toContain('pre-migrate-v10-20230101T000000000Z-1.db');
    expect(migrateBackups).toContain('pre-migrate-v3-20220101T000000000Z-1.db');
    expect(migrateBackups).not.toContain('pre-migrate-v2-20210101T000000000Z-1.db');
    expect(migrateBackups).not.toContain('pre-migrate-v1-20200101T000000000Z-1.db');
    expect(remaining).toContain('pre-restore-20240101T000000000Z.db');
    expect(remaining).toContain('notes.txt');
  });

  describe('when a damaged page keeps SQLite from vacuuming the database into a copy', () => {
    beforeEach(() => {
      // Schema 1-4 with a full-text table a released 0.1.7 built; one page of it is bad.
      createBaseHealthyDatabase(dbPath);
      corruptTablePage(dbPath, 'entries_fts_data');
    });

    it('copies the pages as they are, so the migration is still protected', async () => {
      const bytesBefore = sha256(dbPath);
      const checksumsBefore = tableChecksums(dbPath);

      (await SqliteEngine.create(dbPath)).close();

      const [name, ...others] = backupFiles(tempDir);
      expect(others).toEqual([]);
      const backupPath = join(tempDir, BACKUP_DIR, name!);
      expect(name).toMatch(BACKUP_NAME);
      expect(sha256(backupPath)).toBe(bytesBefore);
      expect(recordedVersions(backupPath)).toEqual([1, 2, 3, 4]);
      expect(tableChecksums(backupPath)).toEqual(checksumsBefore);
    });

    it.skipIf(process.platform === 'win32')(
      'keeps that copy readable by its owner only',
      async () => {
        (await SqliteEngine.create(dbPath)).close();

        const [name] = backupFiles(tempDir);
        expect(statSync(join(tempDir, BACKUP_DIR, name!)).mode & 0o777).toBe(0o600);
      },
    );

    it('then migrates, and opens with full-text search marked unavailable', async () => {
      const checksumsBefore = tableChecksums(dbPath);

      (await SqliteEngine.create(dbPath)).close();

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(engineMeta(dbPath).fts_state).toBe('unavailable');
      expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
    });
  });

  describe('when it cannot be written', () => {
    beforeEach(() => createMaintainerShapedDatabase(dbPath));

    it('aborts the migration with MigrationBackupError and leaves the file untouched', async () => {
      scenario.failBackup = 'at-once';
      const bytesBefore = sha256(dbPath);

      const failure = await SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(MigrationBackupError);
      expect((failure as Error).message).toMatch(/backup/i);
      expect((failure as Error).message).toContain('disk full');
      expect(sha256(dbPath)).toBe(bytesBefore);
      expect(recordedVersions(dbPath)).toEqual([1, 2, 3, 4]);
    });

    it('leaves no half-written file behind', async () => {
      scenario.failBackup = 'after-writing';

      await SqliteEngine.create(dbPath).catch(() => undefined);

      expect(backupFiles(tempDir)).toEqual([]);
    });

    it('does so when the backup folder cannot be created', async () => {
      // A file where the folder has to go.
      writeFileSync(join(tempDir, BACKUP_DIR), 'in the way');
      const bytesBefore = sha256(dbPath);

      const failure = await SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(MigrationBackupError);
      expect(sha256(dbPath)).toBe(bytesBefore);
      expect(recordedVersions(dbPath)).toEqual([1, 2, 3, 4]);
    });
  });

  // The engine switches a file in rollback-journal mode to write-ahead logging before it tries the
  // copy, so the bytes of such a file do change although nothing is migrated. What the user is
  // promised, and what is checked here, is the data: the versions, the schema and every row.
  describe('when it cannot be written for a file still in rollback-journal mode', () => {
    let before: DatabaseData;

    async function failureOfOpening(): Promise<unknown> {
      return SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    beforeEach(() => {
      createLegacyDatabase(dbPath);
      before = dataOf(dbPath);
    });

    it('aborts the migration and leaves the versions, the schema and the rows as they were', async () => {
      scenario.failBackup = 'at-once';

      const failure = await failureOfOpening();

      expect(failure).toBeInstanceOf(MigrationBackupError);
      expect(dataOf(dbPath)).toEqual(before);
      expect(
        withReadonlyDatabase(dbPath, (db) => db.pragma('integrity_check', { simple: true })),
      ).toBe('ok');
    });

    it('does the same when the backup folder cannot be created', async () => {
      writeFileSync(join(tempDir, BACKUP_DIR), 'in the way');

      const failure = await failureOfOpening();

      expect(failure).toBeInstanceOf(MigrationBackupError);
      expect(dataOf(dbPath)).toEqual(before);
    });

    it('does not say the database is unmodified, which its journal mode already contradicts', async () => {
      scenario.failBackup = 'at-once';

      const failure = await failureOfOpening();

      expect((failure as Error).message).toMatch(/nothing was migrated and no data was changed/i);
      expect((failure as Error).message).not.toMatch(/database not modified/i);
    });

    it('migrates completely once the copy can be written', async () => {
      scenario.failBackup = 'at-once';
      await failureOfOpening();
      scenario.failBackup = undefined;

      (await SqliteEngine.create(dbPath)).close();

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(backupFiles(tempDir)).toHaveLength(1);
    });
  });
});
