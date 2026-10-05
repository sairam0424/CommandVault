import { openSync, statSync, type BigIntStats } from 'node:fs';
import { errorCode } from './db-errors.js';

/** Owner-only, for the database and every file an open or a repair creates beside it. */
export const OWNER_ONLY_MODE = 0o600;

/** Runs a file operation, answering `whenMissing` if the file is not there. Other errors escape. */
export function orWhenMissing<T>(whenMissing: T, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return whenMissing;
    throw error;
  }
}

export function fingerprintOf(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
}

/**
 * Identity and state of a file (device, inode, size, mtime): it changes when the file is replaced,
 * rewritten or emptied, as a repair in another process does. Undefined when there is no file.
 */
export function fileFingerprint(path: string): string | undefined {
  return orWhenMissing(undefined, () => fingerprintOf(statSync(path, { bigint: true })));
}

/** Whether a process with this id runs (one that belongs to another user still counts). */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Exclusive-creates an owner-only file: its descriptor, or undefined when the name is taken. */
export function createExclusive(path: string): number | undefined {
  try {
    return openSync(path, 'wx', OWNER_ONLY_MODE);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined;
    throw error;
  }
}
