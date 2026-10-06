import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAVORITE_ID,
  FTS_MARKER_WORD,
  SAMPLE_ENTRY_COUNT,
  USED_ID,
  createBaseHealthyDatabase,
  createLegacyDatabase,
  createMaintainerShapedDatabase,
  engineMeta,
  ftsMatches,
  ftsRowCount,
  recordedVersions,
  withReadonlyDatabase,
  CURRENT_VERSIONS,
} from './migration-fixtures.js';

// Several processes open the same not-yet-migrated database at once, repeatedly: none of them may
// fail, and the file must end up migrated once, with a working full-text table.
//
// The compiled worker is used, because real processes must load the modules a user's would.
// `turbo run test` builds first; running vitest alone needs `pnpm build` once.
const WORKER_PATH = fileURLToPath(
  new URL('../../dist/__tests__/migration-race-worker.js', import.meta.url),
);

const WORKER_COUNT = 6;
const DEFAULT_CYCLES = 25;
const CYCLES = Number(process.env.CV_MIGRATION_RACE_CYCLES ?? DEFAULT_CYCLES);
const READY_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
const START_USAGE = 3;

interface WorkerReport {
  readonly workerId: string;
  readonly cycles: number;
  readonly failures: ReadonlyArray<{ name: string; message: string }>;
}

interface Worker {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly report: Promise<WorkerReport>;
}

function startWorker(dbPath: string, workerId: string, home: string): Worker {
  const child = fork(WORKER_PATH, [dbPath, workerId, String(CYCLES), USED_ID], {
    // Its own HOME: nothing a worker does may reach the real ~/.commandvault or ~/.claude.
    env: { ...process.env, HOME: home, USERPROFILE: home, COMMANDVAULT_HOME: join(home, '.cv') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${workerId} not ready: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      if (message === 'ready') resolve();
      else reject(new Error(`${workerId} failed to start: ${JSON.stringify(message)}`));
    });
    child.on('error', reject);
  });
  const report = new Promise<WorkerReport>((resolve, reject) => {
    child.on('message', (message) => {
      if (message !== 'ready') resolve(message as WorkerReport);
    });
    child.on('exit', (code) =>
      reject(new Error(`${workerId} exited (${code}) before reporting: ${stderr}`)),
    );
  });
  return { child, ready, report };
}

/** Starts the workers, waits until all have loaded, then releases them in the same instant. */
async function runWorkersTogether(dbPath: string, home: string): Promise<WorkerReport[]> {
  const workers = Array.from({ length: WORKER_COUNT }, (_, index) =>
    startWorker(dbPath, `w${index}`, home),
  );
  try {
    await Promise.all(workers.map((worker) => worker.ready));
  } catch (error) {
    workers.forEach((worker) => worker.child.kill('SIGKILL'));
    throw error;
  }
  workers.forEach((worker) => worker.child.send('go'));
  const reports = await Promise.all(workers.map((worker) => worker.report));
  workers.forEach((worker) => worker.child.kill());
  return reports;
}

interface Shape {
  readonly label: string;
  readonly create: (path: string) => void;
  /** Rows the full-text table holds at the end: a rebuilt table has the entries, no more. */
  readonly ftsRows: number;
  /** Ids the row only the full-text table had still matches, i.e. the table was not rebuilt. */
  readonly markerMatches: readonly string[];
}

const SHAPES: readonly Shape[] = [
  {
    label: 'written by @commandvault/core 0.1.0 (schema 2, legacy full-text table)',
    create: createLegacyDatabase,
    ftsRows: SAMPLE_ENTRY_COUNT,
    markerMatches: [],
  },
  {
    label: "shaped like the maintainer's (schema 1-4, orphan entries_fts_content)",
    create: createMaintainerShapedDatabase,
    ftsRows: SAMPLE_ENTRY_COUNT,
    markerMatches: [],
  },
  {
    // What most users have: a released 0.1.7 built it, so only migration 5 is missing and the
    // full-text table is healthy. Its state is still 'pending', which the first open to see it
    // records as 'ready': a write that every process racing for the first open wants to make.
    label: 'built by 0.1.7 (schema 1-4, healthy full-text table, state still pending)',
    create: createBaseHealthyDatabase,
    ftsRows: SAMPLE_ENTRY_COUNT + 1,
    markerMatches: ['marker'],
  },
];

describe.each(SHAPES)('concurrent opens of a database $label', (shape) => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-migration-race-'));
    dbPath = join(tempDir, 'vault.db');
    shape.create(dbPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it(
    `lets ${WORKER_COUNT} processes open it ${CYCLES} times each, and ends with it migrated once`,
    async () => {
      const reports = await runWorkersTogether(dbPath, tempDir);

      const failures = reports.flatMap((report) =>
        report.failures.map((failure) => `${report.workerId}: ${failure.name}: ${failure.message}`),
      );
      expect(failures).toEqual([]);
      expect(reports.map((report) => report.cycles)).toEqual(Array(WORKER_COUNT).fill(CYCLES));

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(engineMeta(dbPath).fts_state).toBe('ready');
      expect(ftsRowCount(dbPath)).toBe(shape.ftsRows);
      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
      expect(ftsMatches(dbPath, FTS_MARKER_WORD)).toEqual(shape.markerMatches);
      expect(
        withReadonlyDatabase(dbPath, (db) => db.pragma('integrity_check', { simple: true })),
      ).toBe('ok');
      expect(usageOf(dbPath, USED_ID)).toBe(START_USAGE + WORKER_COUNT * CYCLES);
      // Whoever got the write lock first migrated, and took the one copy there was to take: the
      // others found nothing left to do. Six copies pruned to three would hide a race.
      const backupDir = join(tempDir, 'backups');
      expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

function usageOf(dbPath: string, id: string): number {
  return withReadonlyDatabase(
    dbPath,
    (db) =>
      (db.prepare('SELECT usage_count AS n FROM entries WHERE id = ?').get(id) as { n: number }).n,
  );
}
