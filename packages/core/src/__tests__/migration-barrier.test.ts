import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_VERSIONS,
  createLegacyDatabase,
  ftsRowCount,
  recordedVersions,
  SAMPLE_ENTRY_COUNT,
} from './migration-fixtures.js';

// The opens of migration-concurrency.test.ts start one IPC message apart, which is long enough for
// the first process to finish switching a database out of rollback-journal mode before the others
// begin. Here every process is held at a barrier and leaves it at the same millisecond, on a
// database that is still a 0.1.0 one, so that they really do reach for the same locks together.
//
// The compiled worker is used, because real processes must load the modules a user's would.
// `turbo run test` builds first; running vitest alone needs `pnpm build` once.
const WORKER_PATH = fileURLToPath(
  new URL('../../dist/__tests__/migration-barrier-worker.js', import.meta.url),
);

const WORKER_COUNT = 6;
const DEFAULT_ROUNDS = 30;
const ROUNDS = Number(process.env.CV_MIGRATION_BARRIER_ROUNDS ?? DEFAULT_ROUNDS);
// Time for the round to reach every worker before the barrier opens.
const BARRIER_DELAY_MS = 120;
const READY_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

interface Reply {
  readonly workerId: string;
  readonly failure?: { readonly name: string; readonly message: string };
}

interface Worker {
  readonly workerId: string;
  readonly child: ChildProcess;
  /** The next message the worker sends, as a promise; ask for it before provoking it. */
  readonly nextMessage: () => Promise<unknown>;
}

async function startWorker(workerId: string, home: string): Promise<Worker> {
  const child = fork(WORKER_PATH, [workerId, join(home, `warmup-${workerId}.db`)], {
    // Its own HOME: nothing a worker does may reach the real ~/.commandvault or ~/.claude.
    env: { ...process.env, HOME: home, USERPROFILE: home, COMMANDVAULT_HOME: join(home, '.cv') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const nextMessage = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const onExit = (code: number | null): void =>
        reject(new Error(`${workerId} exited (${code}) before answering: ${stderr}`));
      child.once('exit', onExit);
      child.once('message', (message) => {
        child.off('exit', onExit);
        resolve(message);
      });
    });

  const ready = nextMessage();
  const timer = setTimeout(() => child.kill('SIGKILL'), READY_TIMEOUT_MS);
  try {
    const message = await ready;
    if (message !== 'ready') throw new Error(`${workerId} failed to start: ${stderr}`);
  } finally {
    clearTimeout(timer);
  }
  return { workerId, child, nextMessage };
}

/** Sends every worker the same database and start time, and collects what each one says. */
async function openTogether(workers: readonly Worker[], dbPath: string): Promise<Reply[]> {
  const startAt = Date.now() + BARRIER_DELAY_MS;
  const replies = workers.map((worker) => worker.nextMessage() as Promise<Reply>);
  workers.forEach((worker) => worker.child.send({ dbPath, startAt }));
  return Promise.all(replies);
}

describe('concurrent first opens of a database written by @commandvault/core 0.1.0', () => {
  let tempDir: string;
  let workers: Worker[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-migration-barrier-'));
    workers = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, index) => startWorker(`w${index}`, tempDir)),
    );
  }, READY_TIMEOUT_MS * 2);

  afterEach(async () => {
    workers.forEach((worker) => worker.child.kill());
    await rm(tempDir, { recursive: true, force: true });
  });

  it(
    `lets ${WORKER_COUNT} processes released together open it, ${ROUNDS} databases in a row`,
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const dir = join(tempDir, `round-${round}`);
        await mkdir(dir);
        const dbPath = join(dir, 'vault.db');
        createLegacyDatabase(dbPath);

        const replies = await openTogether(workers, dbPath);

        const failures = replies.flatMap(({ workerId, failure }) =>
          failure === undefined ? [] : [`${workerId}: ${failure.name}: ${failure.message}`],
        );
        expect(failures, `round ${round}`).toEqual([]);
        // Whoever got in first migrated it, once, and took the one copy there was to take.
        expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
        expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
        const backups = join(dir, 'backups');
        expect(existsSync(backups) ? readdirSync(backups) : []).toHaveLength(1);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
