import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseLockedError } from './db-errors.js';
import { OWNER_ONLY_MODE, isProcessRunning, sleepSync } from './quarantine-fs.js';
import {
  QUARANTINE_LOCK_WAIT_MS,
  repairLockExists,
  waitForRepairToEnd,
} from './quarantine-lock.js';

/**
 * A repair empties vault.db in place and deletes its -wal and -shm. A process that is in the middle
 * of opening the file at that moment holds the old -wal and -shm, and goes on to use them: it
 * reports a working database whose writes no later process ever sees, and when it closes it deletes
 * the files of the new database by name. So an open and a repair must never overlap.
 *
 * While it opens the file, a process leaves a marker next to it. A repair waits for the markers of
 * the other processes to go (see waitForOpeners); an open does not start while a repair holds its
 * lock (see withRegisteredOpener). Each side writes its own file first and then looks for the
 * other's, so one of them always sees the other.
 */
const OPENER_INFIX = '.opening.';
const OPENER_POLL_MS = 10;

function registerOpener(dbPath: string): string {
  const marker = `${dbPath}${OPENER_INFIX}${process.pid}.${randomUUID()}`;
  closeSync(openSync(marker, 'wx', OWNER_ONLY_MODE));
  return marker;
}

function unregisterOpener(marker: string): void {
  try {
    unlinkSync(marker);
  } catch {
    // The open's outcome stands. A marker left behind makes a repair wait for this process, and the
    // timeout names the file to delete (see waitForOpeners).
  }
}

/**
 * Runs `open`, an attempt to open `dbPath` that does not wait for anything, as one a repair waits
 * for. It does not start while a repair holds the lock, and gives up when that outlasts `waitMs`.
 */
export function withRegisteredOpener<T>(
  dbPath: string,
  open: () => T,
  waitMs: number = QUARANTINE_LOCK_WAIT_MS,
): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    waitForRepairToEnd(dbPath, deadline);
    const marker = registerOpener(dbPath);
    if (!repairLockExists(dbPath)) {
      try {
        return open();
      } finally {
        unregisterOpener(marker);
      }
    }
    unregisterOpener(marker); // a repair began after the lock was last looked at; it cannot see us
  }
}

/** The markers of processes other than this one that are still running, and so still opening. */
function markersOfRunningOpeners(dbPath: string): string[] {
  const folder = dirname(dbPath);
  const prefix = `${basename(dbPath)}${OPENER_INFIX}`;
  return readdirSync(folder)
    .filter((name) => name.startsWith(prefix))
    .filter((name) => isRunningOpener(name.slice(prefix.length), join(folder, name)))
    .map((name) => join(folder, name));
}

/** `rest` is "<process id>.<random>". The marker of a process that has died is deleted. */
function isRunningOpener(rest: string, marker: string): boolean {
  const pid = Number(rest.split('.')[0]);
  // This process runs its open and its repair one after the other, so its own markers are not open.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (isProcessRunning(pid)) return true;
  unregisterOpener(marker);
  return false;
}

/**
 * Waits until no other running process is opening `dbPath`. Call it with the repair lock held, so
 * no new open can start, and before anything is changed.
 */
export function waitForOpeners(dbPath: string, waitMs: number): void {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [stillOpening] = markersOfRunningOpeners(dbPath);
    if (stillOpening === undefined) return;
    if (Date.now() >= deadline) {
      throw new DatabaseLockedError(
        dbPath,
        new Error(
          `another process is still opening this file (${stillOpening}); ` +
            'if no CommandVault process is running, delete that file',
        ),
      );
    }
    sleepSync(OPENER_POLL_MS);
  }
}
