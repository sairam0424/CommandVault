import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { DatabaseLockedError, DatabasePermissionError } from '../indexer/db-errors.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  FAVORITE_ID,
  createLegacyDatabase,
  createMaintainerShapedDatabase,
  ftsMatches,
  recordedVersions,
  schemaObjects,
  tableChecksums,
  withDatabase,
  withReadonlyDatabase,
  CURRENT_VERSIONS,
} from './migration-fixtures.js';

// A migration either happens completely or not at all, and a process that cannot get the write
// lock says so in words instead of leaving a half-migrated file behind.

const SHORT_BUSY_TIMEOUT_MS = 100;
const CANNOT_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;
const INJECTED = 'injected failure';

const scenario = vi.hoisted(() => ({
  failStatement: undefined as RegExp | undefined,
  /** Runs `sql` on the real connection, once, right before the first statement that matches. */
  plant: undefined as { statement: RegExp; sql: string } | undefined,
  staleVersions: undefined as number[] | undefined,
  busyTimeout: undefined as number | undefined,
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (path: string, options?: Record<string, unknown>) => {
      const adapter = await original.createDatabaseAdapter(path, {
        ...options,
        ...(scenario.busyTimeout === undefined ? {} : { busyTimeout: scenario.busyTimeout }),
      });
      let hasServedStaleRead = false;
      return instrumentAdapter(adapter, {
        beforeExecute: (sql) => {
          if (scenario.failStatement?.test(sql)) throw new Error(INJECTED);
          const planted = scenario.plant;
          if (planted?.statement.test(sql)) {
            scenario.plant = undefined;
            adapter.execute(planted.sql);
          }
        },
        answerQuery: (sql) => {
          if (hasServedStaleRead || scenario.staleVersions === undefined) return undefined;
          if (!/FROM schema_version/i.test(sql)) return undefined;
          hasServedStaleRead = true;
          return scenario.staleVersions.map((version) => ({ version }));
        },
      });
    },
  };
});

/** Everything about the file's contents that a rolled-back migration must leave as it was. */
function logicalState(path: string): {
  versions: number[];
  objects: Array<[string, string]>;
  checksums: Record<string, string>;
} {
  return {
    versions: recordedVersions(path),
    objects: [...schemaObjects(path).entries()].sort(([a], [b]) => a.localeCompare(b)),
    checksums: tableChecksums(path),
  };
}

describe('migration atomicity', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-migration-atomic-'));
    dbPath = join(tempDir, 'vault.db');
  });

  afterEach(async () => {
    scenario.failStatement = undefined;
    scenario.plant = undefined;
    scenario.staleVersions = undefined;
    scenario.busyTimeout = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('when a migration throws part of the way through', () => {
    beforeEach(() => createLegacyDatabase(dbPath));

    it('rolls back every earlier step and leaves the file at the version it was at', async () => {
      const before = logicalState(dbPath);
      // Fails on the last migration, after the earlier ones have already changed the schema.
      scenario.failStatement = /CREATE TABLE IF NOT EXISTS engine_meta/i;

      await expect(SqliteEngine.create(dbPath)).rejects.toThrow(INJECTED);

      expect(logicalState(dbPath)).toEqual(before);
      expect(
        withReadonlyDatabase(dbPath, (db) => db.pragma('integrity_check', { simple: true })),
      ).toBe('ok');
      // The legacy full-text table and its triggers are as they were.
      const legacyMatches = withReadonlyDatabase(dbPath, (db) =>
        db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'deployment'").all(),
      );
      expect(legacyMatches).toHaveLength(1);
    });

    it('fails loudly, and rolls back, when a migration records a version that is already recorded', async () => {
      const before = logicalState(dbPath);
      // Something else recorded version 5 inside the same transaction, before migration 5 did. A
      // tolerant INSERT would swallow that; the migration is wrong, and must not look like it worked.
      scenario.plant = {
        statement: /CREATE TABLE IF NOT EXISTS engine_meta/i,
        sql: "INSERT INTO schema_version (version, description) VALUES (5, 'recorded by mistake')",
      };

      await expect(SqliteEngine.create(dbPath)).rejects.toThrow(
        /UNIQUE constraint failed: schema_version\.version/,
      );

      expect(logicalState(dbPath)).toEqual(before);
    });

    it('migrates completely the next time it is opened', async () => {
      scenario.failStatement = /CREATE TABLE IF NOT EXISTS engine_meta/i;
      await expect(SqliteEngine.create(dbPath)).rejects.toThrow(INJECTED);
      scenario.failStatement = undefined;

      (await SqliteEngine.create(dbPath)).close();

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
    });
  });

  describe('when rebuilding the full-text table throws part of the way through', () => {
    beforeEach(() => createMaintainerShapedDatabase(dbPath));

    it('leaves the orphan table in place rather than a half-built replacement', async () => {
      const before = tableChecksums(dbPath);
      // After the orphan has been dropped and the new table created, while filling it.
      scenario.failStatement = /INSERT INTO entries_fts\(id, name, description, content, tags\)/i;

      await expect(SqliteEngine.create(dbPath)).rejects.toThrow(INJECTED);

      const objects = schemaObjects(dbPath);
      expect(objects.has('entries_fts')).toBe(false);
      expect(objects.has('entries_fts_data')).toBe(false);
      expect(objects.has('entries_fts_content')).toBe(true);
      expect(tableChecksums(dbPath)).toEqual(before);
    });

    it('heals on the next open', async () => {
      scenario.failStatement = /INSERT INTO entries_fts\(id, name, description, content, tags\)/i;
      await expect(SqliteEngine.create(dbPath)).rejects.toThrow(INJECTED);
      scenario.failStatement = undefined;

      (await SqliteEngine.create(dbPath)).close();

      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
    });
  });

  describe('when another process already migrated the file after this one looked', () => {
    beforeEach(async () => {
      (await SqliteEngine.create(dbPath)).close();
      withDatabase(dbPath, (db) =>
        db
          .prepare(
            `INSERT INTO entries_fts (id, name, description, content, tags)
             VALUES (?, 'marker', 'marker', 'raceproof', '')`,
          )
          .run('c0ffee000001'),
      );
      scenario.staleVersions = [1, 2];
    });

    it('succeeds, and leaves the live full-text table and its rows alone', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(ftsMatches(dbPath, 'raceproof')).toEqual(['c0ffee000001']);
    });

    it('does not keep a backup it turned out not to need', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(existsSync(join(tempDir, 'backups'))).toBe(false);
    });
  });

  describe.skipIf(CANNOT_CHMOD)('when the database file cannot be written to', () => {
    beforeEach(() => {
      createMaintainerShapedDatabase(dbPath);
      chmodSync(dbPath, 0o444);
    });

    afterEach(() => chmodSync(dbPath, 0o644));

    it('fails with DatabasePermissionError and changes nothing', async () => {
      const bytesBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');

      const failure = await SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(bytesBefore);
      expect(existsSync(join(tempDir, 'backups'))).toBe(false);
    });
  });

  describe('when another process holds the write lock', () => {
    let holder: Database.Database;

    beforeEach(() => {
      createMaintainerShapedDatabase(dbPath);
      holder = new Database(dbPath);
      holder.exec('BEGIN IMMEDIATE');
      scenario.busyTimeout = SHORT_BUSY_TIMEOUT_MS;
    });

    afterEach(() => {
      holder.exec('ROLLBACK');
      holder.close();
    });

    it('fails with DatabaseLockedError, not the raw "database is locked"', async () => {
      const failure = await SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect((failure as Error).message).toContain(dbPath);
    });

    it('leaves the file unmigrated and no backup behind', async () => {
      const before = logicalState(dbPath);

      await SqliteEngine.create(dbPath).catch(() => undefined);

      expect(logicalState(dbPath)).toEqual(before);
      expect(existsSync(join(tempDir, 'backups'))).toBe(false);
    });
  });

  describe('when another process holds the write lock while the full-text table needs rebuilding', () => {
    let holder: Database.Database;

    beforeEach(async () => {
      (await SqliteEngine.create(dbPath)).close();
      withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));
      holder = new Database(dbPath);
      holder.exec('BEGIN IMMEDIATE');
      scenario.busyTimeout = SHORT_BUSY_TIMEOUT_MS;
    });

    afterEach(() => {
      holder.exec('ROLLBACK');
      holder.close();
    });

    it('fails with DatabaseLockedError and leaves the file as it was', async () => {
      const before = logicalState(dbPath);

      const failure = await SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(logicalState(dbPath)).toEqual(before);
    });
  });
});
