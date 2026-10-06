import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseCorruptError, DatabaseLockedError } from '../indexer/db-errors.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  CURRENT_VERSIONS,
  corruptTablePage,
  createLegacyDatabase,
  recordedVersions,
  withReadonlyDatabase,
} from './migration-fixtures.js';

// What a typed open error may promise about the file depends on how far the open got. Nothing has
// been written before the switch to write-ahead logging; the switch alone changes the bytes and
// the journal mode of a file that was in rollback mode, and leaves every entry as it was; and once
// the migrations have committed the schema may be new. "Database not modified." holds only for the
// first of these.

const SHORT_BUSY_TIMEOUT_MS = 150;
const SCHEMA_VERSION_READ = /FROM schema_version/i;
const FTS_MODULE_PROBE = /pragma_module_list/;

const scenario = vi.hoisted(() => ({
  /** Runs once, right before the first query whose text matches `when`. */
  hook: undefined as { when: RegExp; run: () => void } | undefined,
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (path: string, options?: Record<string, unknown>) =>
      instrumentAdapter(
        await original.createDatabaseAdapter(path, {
          ...options,
          busyTimeout: SHORT_BUSY_TIMEOUT_MS,
        }),
        {
          beforeQuery: (sql) => {
            const hook = scenario.hook;
            if (hook === undefined || !hook.when.test(sql)) return;
            scenario.hook = undefined;
            hook.run();
          },
        },
      ),
  };
});

async function failureOf(path: string): Promise<Error> {
  const failure = await SqliteEngine.create(path).then(
    (engine) => {
      engine.close();
      return undefined;
    },
    (error: unknown) => error as Error,
  );
  if (failure === undefined) throw new Error('the database was expected to fail to open');
  return failure;
}

function backupCount(dir: string): number {
  const backups = join(dir, 'backups');
  return existsSync(backups) ? readdirSync(backups).length : 0;
}

describe('what a failed open says about the file', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-open-file-state-'));
    dbPath = join(tempDir, 'vault.db');
    createLegacyDatabase(dbPath);
  });

  afterEach(async () => {
    scenario.hook = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('for a lock met before anything was written', () => {
    it('says the database was not modified, and it was not', async () => {
      scenario.hook = {
        when: SCHEMA_VERSION_READ,
        run: () => {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
      };

      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(failure.message).toMatch(/database not modified/i);
      expect(recordedVersions(dbPath)).toEqual([1, 2]);
      expect(
        withReadonlyDatabase(dbPath, (db) => db.pragma('journal_mode', { simple: true })),
      ).toBe('delete');
    });
  });

  describe('for a lock met after the migrations committed', () => {
    it('does not say the database was not modified, and says what was kept', async () => {
      // Another process takes the write lock right as the full-text table is about to be checked.
      const other = new Database(dbPath);
      scenario.hook = { when: FTS_MODULE_PROBE, run: () => other.exec('BEGIN IMMEDIATE') };
      let failure: Error;
      try {
        failure = await failureOf(dbPath);
      } finally {
        other.exec('ROLLBACK');
        other.close();
      }

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(failure.message).not.toMatch(/database not modified/i);
      expect(failure.message).toMatch(/no entry was changed or deleted/i);
      expect(failure.message).toMatch(/"backups" folder/);
      // ... and that is what happened.
      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(backupCount(tempDir)).toBe(1);
    });
  });

  describe('for damaged entries met while the migrations run', () => {
    beforeEach(() => corruptTablePage(dbPath, 'entries'));

    it('does not say the database was not modified, and says what may have changed', async () => {
      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(DatabaseCorruptError);
      expect(failure.message).not.toMatch(/database not modified/i);
      expect(failure.message).toMatch(/no entry was changed or deleted/i);
      expect(failure.message).toMatch(/write-ahead logging/i);
      expect(failure.message).toMatch(/restore it from a backup/);
    });

    it('is right about it: the journal mode changed, the migrations were rolled back', async () => {
      await failureOf(dbPath);

      expect(
        withReadonlyDatabase(dbPath, (db) => db.pragma('journal_mode', { simple: true })),
      ).toBe('wal');
      expect(recordedVersions(dbPath)).toEqual([1, 2]);
      expect(backupCount(tempDir)).toBe(0);
    });
  });
});
