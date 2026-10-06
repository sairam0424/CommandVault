import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';

// Two processes opening the same database for the first time can interleave: one finishes
// migrating while the other is still holding the versions it read before. The slower process must
// not run the legacy FTS cleanup against the standalone table the first one created.
//
// It used to fail instead, with "UNIQUE constraint failed: schema_version.version" when it then
// tried to record a migration twice. It now reads the recorded versions again under the write lock
// (see migration-atomicity.test.ts for the rest), finds nothing to do, and opens.

const STALE_VERSIONS = [1, 2];
const MARKER_ID = 'c0ffee000001';
const INJECTED = 'injected failure';

const scenario = vi.hoisted(() => ({
  serveStaleVersions: false,
  failOpening: false,
  closeThrows: false,
  closeCalls: 0,
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter = await original.createDatabaseAdapter(...args);
      let hasServedStaleRead = false;
      return instrumentAdapter(adapter, {
        // The first read of the recorded versions is answered as it was before the winner migrated.
        answerQuery: (sql) => {
          if (!scenario.serveStaleVersions || hasServedStaleRead) return undefined;
          if (!/FROM schema_version/i.test(sql)) return undefined;
          hasServedStaleRead = true;
          return STALE_VERSIONS.map((version) => ({ version }));
        },
        beforeQuery: (sql) => {
          if (scenario.failOpening && /FROM schema_version/i.test(sql)) throw new Error(INJECTED);
        },
        onClose: () => {
          scenario.closeCalls += 1;
          if (scenario.closeThrows) throw new Error('close failed while flushing to disk');
        },
      });
    },
  };
});

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
    scenario.closeCalls = 0;
  });

  afterEach(async () => {
    scenario.serveStaleVersions = false;
    scenario.failOpening = false;
    scenario.closeThrows = false;
    scenario.closeCalls = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('leaves the live FTS table and its rows alone', async () => {
    scenario.serveStaleVersions = true;

    // The stale process no longer collides with the winner's records; what matters, as before, is
    // that it does not take the winner's search index down.
    (await SqliteEngine.create(dbPath)).close();

    const matches = withDatabase(dbPath, (db) =>
      db.prepare('SELECT id FROM entries_fts WHERE entries_fts MATCH ?').all('raceproof'),
    );
    expect(matches).toEqual([{ id: MARKER_ID }]);
  });

  it('releases the database handle when opening fails', async () => {
    scenario.failOpening = true;

    await expect(SqliteEngine.create(dbPath)).rejects.toThrow(INJECTED);

    // An open handle blocks deleting vault.db on Windows.
    expect(scenario.closeCalls).toBe(1);
  });

  it('reports the original error when releasing the handle fails as well', async () => {
    scenario.failOpening = true;
    scenario.closeThrows = true;

    await expect(SqliteEngine.create(dbPath)).rejects.toThrow(INJECTED);
  });
});
