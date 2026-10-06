import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { withReadonlyDatabase } from './migration-fixtures.js';
import {
  describeFailures,
  launchRaceWorkers,
  raceEntries,
  raceEntryId,
  raceJob,
  stopRaceWorkers,
  type RaceReport,
} from './reindex-race-support.js';

// The soak behind reindex-seam.test.ts: four processes toggle favorites and record uses while a
// fifth does what every CLI command does (open, index the whole scan, close) over and over, and a
// sixth only reads. Nothing a process acknowledged may be missing at the end, nobody may fail on a
// lock, and the reader may never fail because the others write. Loss is load-dependent (the audit
// measured 19 of 40 toggles lost at four processes), so the seam test is the gate and this the soak.

const ENTRY_COUNT = 120;
const TOGGLERS = 4;
const IDS_PER_TOGGLER = 10;
const ROUNDS = 4;
const READER_OPENS = 200;
const DEFAULT_TRIALS = 3;
const TRIALS = Number(process.env['CV_REINDEX_RACE_TRIALS'] ?? DEFAULT_TRIALS);
const TEST_TIMEOUT_MS = 5 * 60_000;

interface UserState {
  readonly favorite: number;
  readonly usage_count: number;
}

function userStates(dbPath: string): Map<string, UserState> {
  return withReadonlyDatabase(dbPath, (db) => {
    const rows = db.prepare('SELECT id, favorite, usage_count FROM entries').all() as Array<
      UserState & { id: string }
    >;
    return new Map(rows.map(({ id, ...state }) => [id, state]));
  });
}

function togglerIds(toggler: number): string[] {
  return Array.from({ length: IDS_PER_TOGGLER }, (_, index) =>
    raceEntryId(toggler * IDS_PER_TOGGLER + index),
  );
}

async function runTrial(dbPath: string, tempDir: string): Promise<RaceReport[]> {
  const stopFile = join(tempDir, 'stop');
  const togglers = Array.from({ length: TOGGLERS }, (_, index) =>
    raceJob({
      role: 'toggler',
      workerId: `toggler-${index}`,
      dbPath,
      ids: togglerIds(index),
      rounds: ROUNDS,
    }),
  );
  const reindexer = raceJob({
    role: 'reindexer',
    workerId: 'reindexer',
    dbPath,
    entryCount: ENTRY_COUNT,
    varyContent: true,
    stopFile,
  });
  const reader = raceJob({
    role: 'reader',
    workerId: 'reader',
    dbPath,
    rounds: READER_OPENS,
    reopen: true,
  });

  const workers = await launchRaceWorkers([...togglers, reindexer, reader], tempDir);
  try {
    const togglerReports = await Promise.all(
      workers.slice(0, TOGGLERS).map((worker) => worker.report),
    );
    writeFileSync(stopFile, '');
    const others = await Promise.all(workers.slice(TOGGLERS).map((worker) => worker.report));
    return [...togglerReports, ...others];
  } finally {
    stopRaceWorkers(workers);
  }
}

describe.each(Array.from({ length: TRIALS }, (_, trial) => trial + 1))(
  `trial %i: ${TOGGLERS} togglers, a reindexer and a reader on one database`,
  () => {
    let tempDir: string;
    let dbPath: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cv-reindex-lost-writes-'));
      dbPath = join(tempDir, 'vault.db');
      const engine = await SqliteEngine.create(dbPath);
      engine.index(raceEntries(ENTRY_COUNT));
      engine.close();
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it(
      'ends with every acknowledged toggle and use in the database, and nobody failed',
      async () => {
        const reports = await runTrial(dbPath, tempDir);

        expect(describeFailures(reports)).toEqual([]);
        const states = userStates(dbPath);
        expect(states.size).toBe(ENTRY_COUNT);
        const lost: string[] = [];
        for (const report of reports.filter((r) => r.role === 'toggler')) {
          for (const [id, ledger] of Object.entries(report.toggles)) {
            const state = states.get(id)!;
            if (state.favorite !== (ledger.last ? 1 : 0)) {
              lost.push(`${id}: acknowledged favorite ${ledger.last}, stored ${state.favorite}`);
            }
            if (state.usage_count !== report.increments[id]) {
              lost.push(
                `${id}: acknowledged ${report.increments[id]} uses, stored ${state.usage_count}`,
              );
            }
          }
        }
        expect(lost).toEqual([]);
        const reindexer = reports.find((r) => r.role === 'reindexer')!;
        expect(reindexer.cycles).toBeGreaterThan(0);
        const reader = reports.find((r) => r.role === 'reader')!;
        expect(reader.reads.polls).toBe(READER_OPENS);
        expect(reader.reads.minEntries).toBe(ENTRY_COUNT);
        expect(
          withReadonlyDatabase(dbPath, (db) => db.pragma('integrity_check', { simple: true })),
        ).toBe('ok');
      },
      TEST_TIMEOUT_MS,
    );
  },
);
