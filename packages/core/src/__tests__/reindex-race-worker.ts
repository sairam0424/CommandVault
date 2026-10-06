/**
 * One process of a reindex race test. It is compiled with the package, and the tests run the
 * compiled file, because the processes must load the modules a user's would.
 *
 * usage: node reindex-race-worker.js '<RaceJob as JSON>'
 * It loads the engine, tells its parent it is ready, waits for the parent's "go", plays its role
 * and reports a RaceReport over IPC. See reindex-race-support.ts for the roles.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { SqliteEngine } from '../indexer/sqlite-engine.js';
import {
  raceEntries,
  RACE_SEARCH_WORD,
  type RaceFailure,
  type RaceJob,
  type RaceReport,
  type ReadStats,
  type ToggleLedger,
} from './reindex-race-support.js';

type Engine = typeof SqliteEngine;

const job = JSON.parse(process.argv[2] ?? '{}') as RaceJob;

interface Outcome {
  readonly cycles: number;
  readonly failures: readonly RaceFailure[];
  readonly toggles?: Readonly<Record<string, ToggleLedger>>;
  readonly increments?: Readonly<Record<string, number>>;
  readonly reads?: ReadStats;
}

const NO_READS: ReadStats = { polls: 0, minEntries: 0, minFtsRows: 0, ftsEmptySeen: 0 };

function waitForGo(): Promise<void> {
  return new Promise((resolve) => {
    process.once('message', () => resolve());
    process.send?.('ready');
  });
}

function describeFailure(error: unknown): RaceFailure {
  const failure = error instanceof Error ? error : new Error(String(error));
  const code = (failure as { code?: unknown }).code;
  return {
    name: failure.name,
    code: typeof code === 'string' ? code : undefined,
    message: failure.message,
  };
}

function shouldStop(): boolean {
  return job.stopFile !== undefined && existsSync(job.stopFile);
}

/** The adapter is synchronous, so a pause between polls blocks the thread the same way. */
function pause(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
}

function tally(ledger: ToggleLedger | undefined, acknowledged: boolean): ToggleLedger {
  const previous = ledger ?? { count: 0, trues: 0, falses: 0, last: false };
  return {
    count: previous.count + 1,
    trues: previous.trues + (acknowledged ? 1 : 0),
    falses: previous.falses + (acknowledged ? 0 : 1),
    last: acknowledged,
  };
}

/** Toggles every id once per round and records a use of it, keeping what the engine acknowledged. */
async function runToggler(Engine: Engine): Promise<Outcome> {
  const toggles = new Map<string, ToggleLedger>();
  const increments = new Map<string, number>();
  const failures: RaceFailure[] = [];
  const engine = await Engine.create(job.dbPath);
  try {
    for (let round = 0; round < job.rounds; round += 1) {
      for (const id of job.ids) {
        try {
          toggles.set(id, tally(toggles.get(id), engine.toggleFavorite(id)));
          engine.incrementUsage(id);
          increments.set(id, (increments.get(id) ?? 0) + 1);
        } catch (error) {
          failures.push(describeFailure(error));
        }
      }
    }
  } finally {
    engine.close();
  }
  return {
    cycles: job.rounds,
    failures,
    toggles: Object.fromEntries(toggles),
    increments: Object.fromEntries(increments),
  };
}

/** Records a use of every id once per round. */
async function runUsage(Engine: Engine): Promise<Outcome> {
  const increments = new Map<string, number>();
  const failures: RaceFailure[] = [];
  const engine = await Engine.create(job.dbPath);
  try {
    for (let round = 0; round < job.rounds; round += 1) {
      for (const id of job.ids) {
        try {
          engine.incrementUsage(id);
          increments.set(id, (increments.get(id) ?? 0) + 1);
        } catch (error) {
          failures.push(describeFailure(error));
        }
      }
    }
  } finally {
    engine.close();
  }
  return { cycles: job.rounds, failures, increments: Object.fromEntries(increments) };
}

/** What every CLI command does: open, index the whole scan, close; again and again. */
async function runReindexer(Engine: Engine): Promise<Outcome> {
  const failures: RaceFailure[] = [];
  let cycles = 0;
  while ((job.rounds === 0 || cycles < job.rounds) && !shouldStop()) {
    try {
      const engine = await Engine.create(job.dbPath);
      try {
        engine.index(raceEntries(job.entryCount, job.varyContent ? cycles + 1 : 0));
      } finally {
        engine.close();
      }
    } catch (error) {
      failures.push(describeFailure(error));
    }
    cycles += 1;
  }
  return { cycles, failures };
}

function openReadonly(): Database.Database {
  return new Database(job.dbPath, { readonly: true });
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Reads the way a `vault search` in another process would, without ever taking a write lock. */
function runReader(): Outcome {
  const failures: RaceFailure[] = [];
  let reads: ReadStats = { ...NO_READS, minEntries: Infinity, minFtsRows: Infinity };
  let db = openReadonly();
  try {
    for (let poll = 0; poll < job.rounds && !shouldStop(); poll += 1) {
      try {
        if (job.reopen && poll > 0) {
          db.close();
          db = openReadonly();
        }
        const entries = countRows(db, 'entries');
        const ftsRows = countRows(db, 'entries_fts');
        db.prepare('SELECT id FROM entries_fts WHERE entries_fts MATCH ? LIMIT 1').get(
          RACE_SEARCH_WORD,
        );
        reads = {
          polls: reads.polls + 1,
          minEntries: Math.min(reads.minEntries, entries),
          minFtsRows: Math.min(reads.minFtsRows, ftsRows),
          ftsEmptySeen: reads.ftsEmptySeen + (ftsRows === 0 ? 1 : 0),
        };
      } catch (error) {
        failures.push(describeFailure(error));
      }
      pause(job.pauseMs);
    }
  } finally {
    db.close();
  }
  return { cycles: reads.polls, failures, reads };
}

async function play(Engine: Engine): Promise<Outcome> {
  switch (job.role) {
    case 'toggler':
      return runToggler(Engine);
    case 'usage':
      return runUsage(Engine);
    case 'reindexer':
      return runReindexer(Engine);
    case 'reader':
      return runReader();
  }
}

function report(outcome: Outcome): void {
  const full: RaceReport = {
    workerId: job.workerId,
    role: job.role,
    cycles: outcome.cycles,
    failures: outcome.failures,
    toggles: outcome.toggles ?? {},
    increments: outcome.increments ?? {},
    reads: outcome.reads ?? NO_READS,
  };
  process.send?.(full);
}

async function main(): Promise<void> {
  const { SqliteEngine } = await import('../indexer/sqlite-engine.js');
  await waitForGo();
  report(await play(SqliteEngine));
}

main().catch((error: unknown) => {
  report({ cycles: 0, failures: [describeFailure(error)] });
});
