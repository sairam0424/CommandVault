import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../indexer/database-adapter.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';

// Two processes opening the same database for the first time can interleave: one finishes
// migration 3 while the other is still holding the schema version it read before. The slower
// process must not run the legacy FTS cleanup against the standalone table the first one created.

const STALE_VERSION = 2;
const MARKER_ID = 'c0ffee000001';

const scenario = vi.hoisted(() => ({
  serveStaleVersion: false,
  closeThrows: false,
  closeCalls: 0,
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter = await original.createDatabaseAdapter(...args);
      return scenario.serveStaleVersion ? withStaleFirstVersionRead(adapter) : adapter;
    },
  };
});

/** Delegates to `adapter`, except that the first schema-version read reports an older version. */
function withStaleFirstVersionRead(adapter: DatabaseAdapter): DatabaseAdapter {
  let hasServedStaleRead = false;
  return {
    path: adapter.path,
    queryAll: <T>(sql: string, params?: Record<string, unknown>): T[] => {
      if (!hasServedStaleRead && /MAX\(version\)/i.test(sql)) {
        hasServedStaleRead = true;
        return [{ v: STALE_VERSION }] as unknown as T[];
      }
      return adapter.queryAll<T>(sql, params);
    },
    queryOne: <T>(sql: string, params?: Record<string, unknown>) =>
      adapter.queryOne<T>(sql, params),
    execute: (sql, params) => adapter.execute(sql, params),
    transaction: <T>(fn: () => T) => adapter.transaction(fn),
    close: () => {
      scenario.closeCalls += 1;
      adapter.close();
      if (scenario.closeThrows) throw new Error('close failed while flushing to disk');
    },
  };
}

function withDatabase<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('legacy FTS cleanup when another process already migrated the database', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fts-race-'));
    dbPath = join(tempDir, 'vault.db');

    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) =>
      db
        .prepare(
          `INSERT INTO entries_fts (id, name, description, content, tags)
           VALUES (?, 'marker', 'marker', 'raceproof', '')`,
        )
        .run(MARKER_ID),
    );
  });

  afterEach(async () => {
    scenario.serveStaleVersion = false;
    scenario.closeThrows = false;
    scenario.closeCalls = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('leaves the live FTS table and its rows alone', async () => {
    scenario.serveStaleVersion = true;

    // The stale process still fails when it tries to record migration 3 again (its primary key
    // insert collides); what matters is that it does not take the winner's search index down.
    await expect(SqliteEngine.create(dbPath)).rejects.toThrow(/UNIQUE/);

    const matches = withDatabase(dbPath, (db) =>
      db.prepare('SELECT id FROM entries_fts WHERE entries_fts MATCH ?').all('raceproof'),
    );
    expect(matches).toEqual([{ id: MARKER_ID }]);
  });

  it('releases the database handle when opening fails', async () => {
    scenario.serveStaleVersion = true;

    await expect(SqliteEngine.create(dbPath)).rejects.toThrow(/UNIQUE/);

    // An open handle blocks deleting vault.db on Windows.
    expect(scenario.closeCalls).toBe(1);
  });

  it('reports the original error when releasing the handle fails as well', async () => {
    scenario.serveStaleVersion = true;
    scenario.closeThrows = true;

    await expect(SqliteEngine.create(dbPath)).rejects.toThrow(/UNIQUE/);
  });
});
