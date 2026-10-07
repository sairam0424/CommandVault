import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { VaultEntry } from '../types/index.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { engineMeta, ftsMatches, withReadonlyDatabase } from './migration-fixtures.js';
import { RACE_SEARCH_WORD, raceEntries, raceEntryId } from './reindex-race-support.js';

// A process whose SQLite has no fts5 module (the pure-JavaScript backend) records the full-text
// table unavailable and writes the entries past it: index() maintains full-text rows only while
// the state is ready. The next process with fts5 finds the table healthy as it stands. The failing
// version recorded it ready without filling it again, so a row added, changed or removed meanwhile
// was never reflected and full-text search missed it for good, since index() only maintains the
// rows it writes.

type Backend = 'better-sqlite3' | 'sql.js';

const ENTRY_COUNT = 10;
const CHANGED_INDEX = 3;
const REMOVED_INDEX = 7;
const FRESH_WORD = 'writtenwithoutfts';
const TEST_TIMEOUT_MS = 5 * 60_000;

const scenario = vi.hoisted(() => ({ backend: 'better-sqlite3' as Backend }));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  const { SqlJsAdapter } = await import('../indexer/sqljs-adapter.js');
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) =>
      scenario.backend === 'sql.js'
        ? SqlJsAdapter.create(...args)
        : original.createDatabaseAdapter(...args),
  };
});

/** The scan the process without fts5 indexes: one entry changed, one new, one gone. */
function scanWithoutFts(): VaultEntry[] {
  return raceEntries(ENTRY_COUNT + 1)
    .map((entry, index) =>
      index === CHANGED_INDEX ? { ...entry, content: `${FRESH_WORD} ${entry.content}` } : entry,
    )
    .filter((entry) => entry.id !== raceEntryId(REMOVED_INDEX));
}

function ftsIds(dbPath: string): string[] {
  return withReadonlyDatabase(dbPath, (db) =>
    (db.prepare('SELECT id FROM entries_fts ORDER BY id').all() as { id: string }[]).map(
      ({ id }) => id,
    ),
  );
}

function dataVersionProbe(path: string): { read: () => number; close: () => void } {
  const probe = new Database(path);
  return {
    read: () => probe.pragma('data_version', { simple: true }) as number,
    close: () => probe.close(),
  };
}

async function indexOn(
  backend: Backend,
  dbPath: string,
  entries: readonly VaultEntry[],
): Promise<void> {
  scenario.backend = backend;
  const engine = await SqliteEngine.create(dbPath);
  try {
    engine.index(entries);
  } finally {
    engine.close();
  }
}

describe('the full-text table after a process without fts5 wrote the entries', () => {
  let tempDir: string;
  let dbPath: string;
  const expectedIds = scanWithoutFts()
    .map(({ id }) => id)
    .sort();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fts-left-behind-'));
    dbPath = join(tempDir, 'vault.db');
    await indexOn('better-sqlite3', dbPath, raceEntries(ENTRY_COUNT));
    await indexOn('sql.js', dbPath, scanWithoutFts());
    scenario.backend = 'better-sqlite3';
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    scenario.backend = 'better-sqlite3';
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts out recorded unavailable, still holding the rows of the scan before', () => {
    expect(engineMeta(dbPath).fts_state).toBe('unavailable');
    expect(ftsIds(dbPath)).toEqual(raceEntries(ENTRY_COUNT).map(({ id }) => id));
  });

  it(
    'is filled again by the next process with fts5, which records it ready',
    async () => {
      const engine = await SqliteEngine.create(dbPath);
      try {
        expect(engineMeta(dbPath).fts_state).toBe('ready');
        expect(ftsIds(dbPath)).toEqual(expectedIds);
        expect(ftsMatches(dbPath, FRESH_WORD)).toEqual([raceEntryId(CHANGED_INDEX)]);
        expect(engine.search({ query: FRESH_WORD, limit: 5 }).map((r) => r.entry.id)).toEqual([
          raceEntryId(CHANGED_INDEX),
        ]);
        expect(
          engine
            .search({ query: RACE_SEARCH_WORD, limit: 50 })
            .map((r) => r.entry.id)
            .sort(),
        ).toEqual(expectedIds);
      } finally {
        engine.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is then left alone: the open after that writes nothing',
    async () => {
      (await SqliteEngine.create(dbPath)).close();
      const probe = dataVersionProbe(dbPath);
      const versionBefore = probe.read();

      (await SqliteEngine.create(dbPath)).close();

      expect(ftsIds(dbPath)).toEqual(expectedIds);
      expect(probe.read()).toBe(versionBefore);
      probe.close();
    },
    TEST_TIMEOUT_MS,
  );
});
