import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VaultEntry } from '../types/index.js';

/**
 * Shared by the multi-process tests of the reindex path (reindex-lost-writes, toggle-favorite-atomic,
 * fts-window) and by later lanes: the entries every process agrees on, the job a forked worker
 * takes, the report it sends back, and the ready/go barrier that releases all workers in the same
 * instant (the pattern of migration-race-worker.ts).
 *
 * The compiled worker is run, because real processes must load the modules a user's would:
 * `turbo run test` builds first; running vitest alone needs `pnpm build` once.
 */

export type RaceRole = 'toggler' | 'usage' | 'reindexer' | 'reader';

export interface RaceJob {
  readonly role: RaceRole;
  readonly workerId: string;
  readonly dbPath: string;
  /** The ids a toggler or usage worker acts on, each once per round. */
  readonly ids: readonly string[];
  /** Rounds for toggler, usage and reader; cycles for a reindexer, 0 meaning until `stopFile`. */
  readonly rounds: number;
  /** How many entries a reindexer offers: the set the database was seeded with, `raceEntries`. */
  readonly entryCount: number;
  /** Reindexer: change every entry's content on every cycle, so that every row is really written. */
  readonly varyContent: boolean;
  /** Reindexer and reader: stop as soon as this file exists. */
  readonly stopFile?: string;
  /** Reader: pause between two polls, in milliseconds. */
  readonly pauseMs: number;
  /** Reader: open a fresh read-only handle for every poll instead of one for the whole run. */
  readonly reopen: boolean;
}

export interface ToggleLedger {
  readonly count: number;
  readonly trues: number;
  readonly falses: number;
  /** The last value `toggleFavorite` acknowledged: what the database must show at the end. */
  readonly last: boolean;
}

export interface ReadStats {
  readonly polls: number;
  readonly minEntries: number;
  readonly minFtsRows: number;
  /** Polls that found the full-text table empty: the window a reader must never see. */
  readonly ftsEmptySeen: number;
}

export interface RaceFailure {
  readonly name: string;
  readonly code: string | undefined;
  readonly message: string;
}

export interface RaceReport {
  readonly workerId: string;
  readonly role: RaceRole;
  readonly cycles: number;
  readonly failures: readonly RaceFailure[];
  readonly toggles: Readonly<Record<string, ToggleLedger>>;
  readonly increments: Readonly<Record<string, number>>;
  readonly reads: ReadStats;
}

export const RACE_SEARCH_WORD = 'racetoken';
const RACE_CONTENT_PADDING = 'x'.repeat(2000);
const RACE_TAG_GROUPS = 4;
const WORKER_PATH = fileURLToPath(
  new URL('../../dist/__tests__/reindex-race-worker.js', import.meta.url),
);
const READY_TIMEOUT_MS = 60_000;

export function raceEntryId(index: number): string {
  return `race${String(index).padStart(5, '0')}`;
}

/** Deterministic entries; a different `stamp` changes every entry's content and nothing else. */
export function raceEntries(count: number, stamp = 0): VaultEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: raceEntryId(index),
    name: `race-entry-${index}`,
    type: 'skill',
    source: 'custom',
    description: `Race entry ${index}`,
    filePath: `/race/${index}/SKILL.md`,
    tags: ['race', `group-${index % RACE_TAG_GROUPS}`],
    metadata: { index },
    content: `${RACE_SEARCH_WORD} body ${index} stamp ${stamp} ${RACE_CONTENT_PADDING}`,
    lastModified: new Date(Date.UTC(2026, 0, 1)),
    favorite: false,
    usageCount: 0,
  }));
}

export function raceJob(
  job: Pick<RaceJob, 'role' | 'workerId' | 'dbPath'> & Partial<RaceJob>,
): RaceJob {
  return {
    ids: [],
    rounds: 0,
    entryCount: 0,
    varyContent: false,
    pauseMs: 0,
    reopen: false,
    ...job,
  };
}

export interface RaceWorker {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly report: Promise<RaceReport>;
}

function startRaceWorker(job: RaceJob, home: string): RaceWorker {
  const child = fork(WORKER_PATH, [JSON.stringify(job)], {
    // Its own HOME: nothing a worker does may reach the real ~/.commandvault or ~/.claude.
    env: { ...process.env, HOME: home, USERPROFILE: home, COMMANDVAULT_HOME: join(home, '.cv') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${job.workerId} not ready: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      if (message === 'ready') resolve();
      else reject(new Error(`${job.workerId} failed to start: ${JSON.stringify(message)}`));
    });
    child.on('error', reject);
  });
  const report = new Promise<RaceReport>((resolve, reject) => {
    child.on('message', (message) => {
      if (message !== 'ready') resolve(message as RaceReport);
    });
    child.on('exit', (code) =>
      reject(new Error(`${job.workerId} exited (${code}) before reporting: ${stderr}`)),
    );
  });
  return { child, ready, report };
}

/** Starts every job, waits until all have loaded, then releases them in the same instant. */
export async function launchRaceWorkers(
  jobs: readonly RaceJob[],
  home: string,
): Promise<RaceWorker[]> {
  const workers = jobs.map((job) => startRaceWorker(job, home));
  try {
    await Promise.all(workers.map((worker) => worker.ready));
  } catch (error) {
    stopRaceWorkers(workers);
    throw error;
  }
  workers.forEach((worker) => worker.child.send('go'));
  return workers;
}

export function stopRaceWorkers(workers: readonly RaceWorker[]): void {
  workers.forEach((worker) => worker.child.kill('SIGKILL'));
}

export function describeFailures(reports: readonly RaceReport[]): string[] {
  return reports.flatMap((report) =>
    report.failures.map(
      (failure) => `${report.workerId}: ${failure.name} ${failure.code ?? ''}: ${failure.message}`,
    ),
  );
}
