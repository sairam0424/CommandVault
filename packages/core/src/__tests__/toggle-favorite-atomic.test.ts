import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseAdapter } from '../indexer/database-adapter.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';
import { instrumentAdapter } from './adapter-instrument.js';
import { withDatabase, withReadonlyDatabase } from './migration-fixtures.js';
import {
  describeFailures,
  launchRaceWorkers,
  raceEntries,
  raceEntryId,
  raceJob,
  stopRaceWorkers,
} from './reindex-race-support.js';

// Toggling a favorite is one statement that flips the value and reads it back. The failing version
// read the value, then wrote its opposite: two processes toggling at once both read 0, both wrote
// 1, and one acknowledged flip was lost.

type Backend = 'better-sqlite3' | 'sql.js';

const ENTRY_COUNT = 8;
const TARGET_INDEX = 2;
const PROCESSES = 4;
const TOGGLES_PER_PROCESS = 50;
const TEST_TIMEOUT_MS = 5 * 60_000;

const scenario = vi.hoisted(() => ({
  backend: 'better-sqlite3' as Backend,
  armed: false,
  dbPath: '',
  targetId: '',
  adapter: undefined as DatabaseAdapter | undefined,
}));

/** The other process flips the same favorite in the instant before this one's statement runs. */
function flipByOtherProcess(): void {
  if (!scenario.armed) return;
  scenario.armed = false;
  withDatabase(scenario.dbPath, (db) =>
    db.prepare('UPDATE entries SET favorite = 1 - favorite WHERE id = ?').run(scenario.targetId),
  );
}

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  const { SqlJsAdapter } = await import('../indexer/sqljs-adapter.js');
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter =
        scenario.backend === 'sql.js'
          ? await SqlJsAdapter.create(...args)
          : await original.createDatabaseAdapter(...args);
      scenario.adapter = adapter;
      return instrumentAdapter(adapter, {
        // The one statement takes the lock as its transaction starts; the old pair wrote after
        // reading, so the other process gets in before its UPDATE.
        onTransaction: flipByOtherProcess,
        beforeExecute: (sql) => {
          if (/UPDATE entries SET favorite/i.test(sql)) flipByOtherProcess();
        },
      });
    },
  };
});

/** Saves the pure-JavaScript database to its file now, so that the next write is the only unsaved one. */
function saveSqlJsFile(): void {
  if (!(scenario.adapter instanceof SqlJsAdapter)) {
    throw new Error('the pure-JavaScript backend is not the one open');
  }
  scenario.adapter.persist();
}

function favoriteOf(dbPath: string, id: string): number {
  return withReadonlyDatabase(
    dbPath,
    (db) =>
      (db.prepare('SELECT favorite FROM entries WHERE id = ?').get(id) as { favorite: number })
        .favorite,
  );
}

describe('toggling a favorite', () => {
  let tempDir: string;
  let dbPath: string;
  const targetId = raceEntryId(TARGET_INDEX);

  beforeEach(async () => {
    scenario.backend = 'better-sqlite3';
    tempDir = await mkdtemp(join(tmpdir(), 'cv-toggle-atomic-'));
    dbPath = join(tempDir, 'vault.db');
    scenario.dbPath = dbPath;
    scenario.targetId = targetId;
  });

  afterEach(async () => {
    scenario.armed = false;
    scenario.adapter = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('in one process', () => {
    it('returns the new state each time, and false for an id it does not have', async () => {
      const engine = await SqliteEngine.create(dbPath);
      try {
        engine.index(raceEntries(ENTRY_COUNT));
        expect(engine.toggleFavorite(targetId)).toBe(true);
        expect(engine.toggleFavorite(targetId)).toBe(false);
        expect(engine.toggleFavorite('no-such-id')).toBe(false);
        expect(engine.getEntry(targetId)?.favorite).toBe(false);
      } finally {
        engine.close();
      }
    });

    it('acknowledges the value the database holds when another process flipped it in between', async () => {
      const engine = await SqliteEngine.create(dbPath);
      try {
        engine.index(raceEntries(ENTRY_COUNT));
        scenario.armed = true;

        const acknowledged = engine.toggleFavorite(targetId);

        // Two flips from 0: back to 0, and the caller was told so.
        expect(favoriteOf(dbPath, targetId)).toBe(0);
        expect(acknowledged).toBe(false);
      } finally {
        engine.close();
      }
    });
  });

  describe('on the pure-JavaScript backend', () => {
    beforeEach(() => {
      scenario.backend = 'sql.js';
    });

    it(
      'is saved to the file, so it is there when the database is opened again',
      async () => {
        const engine = await SqliteEngine.create(dbPath);
        try {
          engine.index(raceEntries(ENTRY_COUNT));
          // On this backend only a statement or a transaction marks the file for saving; the index
          // did, so it is saved first, and the toggle alone decides whether the close saves again.
          saveSqlJsFile();
          expect(engine.toggleFavorite(targetId)).toBe(true);
        } finally {
          engine.close();
        }

        const reopened = await SqliteEngine.create(dbPath);
        try {
          expect(reopened.getEntry(targetId)?.favorite).toBe(true);
          expect(reopened.toggleFavorite(targetId)).toBe(false);
        } finally {
          reopened.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe(`from ${PROCESSES} processes at once, ${TOGGLES_PER_PROCESS} times each on one entry`, () => {
    it(
      'loses no flip: every acknowledgement alternates and the end state matches their number',
      async () => {
        const engine = await SqliteEngine.create(dbPath);
        engine.index(raceEntries(ENTRY_COUNT));
        engine.close();
        const jobs = Array.from({ length: PROCESSES }, (_, index) =>
          raceJob({
            role: 'toggler',
            workerId: `toggler-${index}`,
            dbPath,
            ids: [targetId],
            rounds: TOGGLES_PER_PROCESS,
          }),
        );

        const workers = await launchRaceWorkers(jobs, tempDir);
        let reports;
        try {
          reports = await Promise.all(workers.map((worker) => worker.report));
        } finally {
          stopRaceWorkers(workers);
        }

        expect(describeFailures(reports)).toEqual([]);
        const ledgers = reports.map((report) => report.toggles[targetId]!);
        const total = PROCESSES * TOGGLES_PER_PROCESS;
        expect(ledgers.reduce((sum, ledger) => sum + ledger.count, 0)).toBe(total);
        expect(ledgers.reduce((sum, ledger) => sum + ledger.trues, 0)).toBe(total / 2);
        expect(ledgers.reduce((sum, ledger) => sum + ledger.falses, 0)).toBe(total / 2);
        expect(favoriteOf(dbPath, targetId)).toBe(total % 2);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
