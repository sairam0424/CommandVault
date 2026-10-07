import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withReadonlyDatabase } from './migration-fixtures.js';

/**
 * Shared by the backup and restore tests: a forked writer that holds commits in the write-ahead
 * log (backup-writer-worker.ts), and readers that look at a database file without the engine.
 * The compiled worker is run, like the other workers in this folder: `turbo run test` builds
 * first; running vitest alone needs `pnpm build` once.
 */

const WORKER_PATH = fileURLToPath(
  new URL('../../dist/__tests__/backup-writer-worker.js', import.meta.url),
);
const READY_TIMEOUT_MS = 60_000;

export interface HeldWriter {
  readonly child: ChildProcess;
  /** The usage count the writer read back after its last commit. */
  readonly usage: number;
}

/**
 * Starts a writer that commits `count` usage increments of `entryId` into the -wal of `dbPath`
 * with checkpoints switched off, and keeps its connection open until stopped or killed.
 */
export function startHeldWriter(
  dbPath: string,
  entryId: string,
  count: number,
  home: string,
): Promise<HeldWriter> {
  const child = fork(WORKER_PATH, [dbPath, entryId, String(count)], {
    env: { ...process.env, HOME: home, USERPROFILE: home, COMMANDVAULT_HOME: join(home, '.cv') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`writer not ready after ${READY_TIMEOUT_MS} ms: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve({ child, usage: (message as { usage: number }).usage });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`writer exited (${code}) before it was ready: ${stderr}`));
    });
  });
}

/** Asks the writer to close its connection cleanly (checkpoint, sidecars removed) and exit. */
export function stopHeldWriter(writer: HeldWriter): Promise<void> {
  return new Promise((resolve) => {
    writer.child.once('exit', () => resolve());
    writer.child.send('stop');
  });
}

/** A killed child has `exitCode` null and `signalCode` set, so both say whether it still runs. */
export function isWriterRunning(writer: HeldWriter): boolean {
  return writer.child.exitCode === null && writer.child.signalCode === null;
}

/** Kills the writer outright, the way a crash does: its -wal stays hot beside the database. */
export function killHeldWriter(writer: HeldWriter): Promise<void> {
  return new Promise((resolve) => {
    writer.child.once('exit', () => resolve());
    writer.child.kill('SIGKILL');
  });
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The usage count of one entry, read with a plain read-only connection. */
export function usageOf(path: string, entryId: string): number {
  return withReadonlyDatabase(path, (db) => {
    const row = db.prepare('SELECT usage_count AS usage FROM entries WHERE id = ?').get(entryId);
    return (row as { usage: number }).usage;
  });
}

export function quickCheck(path: string): string {
  return withReadonlyDatabase(path, (db) =>
    (db.pragma('quick_check') as { quick_check: string }[])
      .map((row) => row.quick_check)
      .join('; '),
  );
}

/** Header byte 18, the write version: 1 for a rollback journal, 2 for write-ahead logging. */
export function writeVersionOf(path: string): number {
  return readFileSync(path)[18] ?? -1;
}
