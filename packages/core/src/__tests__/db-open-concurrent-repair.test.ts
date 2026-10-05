import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { backupNames, makeTempDir, seedDatabase } from './db-open-helpers.js';

// The compiled worker: real processes must load the modules a user's would. `turbo run test` builds
// first; running vitest alone needs `pnpm build` once.
const WORKER_PATH = fileURLToPath(
  new URL('../../dist/__tests__/open-race-worker.js', import.meta.url),
);

const WORKER_COUNT = 12;
const REPETITIONS = 30;
const ROWS_PER_WORKER = 3;
const SEEDED_ROWS = 200;
const PHASE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
// Bytes 100 and 101 are the first bytes of the schema page's b-tree header: SQLite reads them when
// it looks at the schema, and finds a page type that does not exist.
const SCHEMA_HEADER_OFFSET = 100;
const INVALID_PAGE_TYPE = 0xff;

interface WorkerRun {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly finished: Promise<WorkerResult>;
}

interface WorkerResult {
  readonly workerId: string;
  readonly outcome: { ok: boolean; name?: string; message?: string } | undefined;
  readonly stderr: string;
}

/** A WAL-mode database (as every one this package writes) whose schema page is damaged. */
function writeDamagedWalDatabase(dbPath: string): Buffer {
  seedDatabase(dbPath, { wal: true, rows: SEEDED_ROWS });
  const bytes = readFileSync(dbPath);
  bytes.fill(INVALID_PAGE_TYPE, SCHEMA_HEADER_OFFSET, SCHEMA_HEADER_OFFSET + 2);
  writeFileSync(dbPath, bytes);
  return bytes;
}

function startWorker(dbPath: string, workerId: string): WorkerRun {
  const child = spawn(process.execPath, [WORKER_PATH, dbPath, workerId, String(ROWS_PER_WORKER)]);
  let stdout = '';
  let stderr = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker ${workerId} was not ready: ${stdout}${stderr}`)),
      PHASE_TIMEOUT_MS,
    );
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.startsWith('ready\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const finished = new Promise<WorkerResult>((resolve) => {
    child.on('close', () => {
      const lastLine = stdout.trim().split('\n').at(-1) ?? '';
      let outcome: WorkerResult['outcome'];
      try {
        outcome = JSON.parse(lastLine) as WorkerResult['outcome'];
      } catch {
        outcome = undefined;
      }
      resolve({ workerId, outcome, stderr });
    });
  });
  return { child, ready, finished };
}

/** Starts the workers, lets them all load, then releases them in the same instant. */
async function runWorkersTogether(dbPath: string): Promise<WorkerResult[]> {
  const workers = Array.from({ length: WORKER_COUNT }, (_, index) =>
    startWorker(dbPath, `w${index}`),
  );
  try {
    await Promise.all(workers.map((worker) => worker.ready));
  } catch (error) {
    workers.forEach((worker) => worker.child.kill('SIGKILL'));
    throw error;
  }
  workers.forEach((worker) => worker.child.stdin!.end());
  return Promise.all(workers.map((worker) => worker.finished));
}

function rowsInDatabase(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT id FROM t').all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } finally {
    db.close();
  }
}

/** Everything that went wrong in one round, in words; empty when nothing did. */
function findProblems(dir: string, original: Buffer, results: readonly WorkerResult[]): string[] {
  // The folder is listed first: reading the rows afterwards leaves a -shm and a -wal behind.
  const problems = [...folderProblems(dir, original), ...workerProblems(results)];
  const stored = rowsInDatabase(join(dir, 'vault.db'));
  for (const result of results.filter((one) => one.outcome?.ok === true)) {
    const missing = Array.from(
      { length: ROWS_PER_WORKER },
      (_, row) => `${result.workerId}.${row}`,
    ).filter((id) => !stored.has(id));
    if (missing.length > 0) {
      problems.push(`${result.workerId} was told its rows were stored, lost: ${missing}`);
    }
  }
  return problems;
}

function workerProblems(results: readonly WorkerResult[]): string[] {
  const problems = results
    .filter((result) => result.outcome?.ok !== true)
    .map((result) => {
      const why = result.outcome
        ? `${result.outcome.name}: ${result.outcome.message}`
        : 'no report';
      return `${result.workerId} failed: ${why} ${result.stderr.slice(0, 200)}`;
    });
  const notices = results.flatMap((result) => result.stderr.match(/CommandVault:/g) ?? []);
  if (notices.length !== 1) problems.push(`expected one notice, got ${notices.length}`);
  return problems;
}

function folderProblems(dir: string, original: Buffer): string[] {
  const problems: string[] = [];
  const [backup, ...otherBackups] = backupNames(dir).filter((name) => name.endsWith('.bak'));
  if (backup === undefined || otherBackups.length > 0) {
    const found = backup === undefined ? 0 : 1 + otherBackups.length;
    problems.push(`expected exactly one backup, found ${found}`);
  } else if (!readFileSync(join(dir, backup)).equals(original)) {
    problems.push('the backup does not hold the original bytes');
  }
  // SQLite leaves the -wal and -shm behind when the last two connections close at the same moment:
  // each finds the other still open, and neither deletes them. That is not a fault of the repair.
  const expectedNames = ['vault.db', 'vault.db-wal', 'vault.db-shm'];
  const unexpectedFiles = readdirSync(dir).filter(
    (name) => !expectedNames.includes(name) && !name.startsWith('vault.db.corrupt.'),
  );
  if (unexpectedFiles.length > 0) problems.push(`files left behind: ${unexpectedFiles}`);
  return problems;
}

describe('opening a damaged database from many processes at once', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    `keeps every row a process was told was stored (${WORKER_COUNT} processes, ${REPETITIONS} rounds)`,
    async () => {
      expect(
        existsSync(WORKER_PATH),
        `${WORKER_PATH} is missing: run "pnpm --filter @commandvault/core build" first`,
      ).toBe(true);
      const problemsByRound: string[] = [];

      for (let round = 1; round <= REPETITIONS; round += 1) {
        const dir = makeTempDir('open-race');
        dirs.push(dir);
        const original = writeDamagedWalDatabase(join(dir, 'vault.db'));

        const results = await runWorkersTogether(join(dir, 'vault.db'));

        for (const problem of findProblems(dir, original, results)) {
          problemsByRound.push(`round ${round}: ${problem}`);
        }
      }

      expect(problemsByRound).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
