import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { BetterSqliteAdapter } from '../indexer/better-sqlite-adapter.js';
import { DatabaseLockedError } from '../indexer/db-errors.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import {
  CURRENT_VERSIONS,
  createLegacyDatabase,
  recordedVersions,
  withReadonlyDatabase,
} from './migration-fixtures.js';

// Two processes that open a database still in rollback-journal mode at the same moment both reach
// for the exclusive lock that the switch to write-ahead logging needs, each holding a shared one.
// SQLite does not wait in that case (waiting could deadlock): it fails the second at once with
// SQLITE_BUSY, without calling the busy handler. The switch has to be tried again by its caller.

const SHORT_BUSY_TIMEOUT_MS = 150;
const TRANSIENT_FAILURES = 3;
const WAL_SWITCH = /^journal_mode\s*=\s*WAL$/i;

const scenario = vi.hoisted(() => ({ busyTimeout: undefined as number | undefined }));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: (path: string, options?: Record<string, unknown>) =>
      original.createDatabaseAdapter(path, {
        ...options,
        ...(scenario.busyTimeout === undefined ? {} : { busyTimeout: scenario.busyTimeout }),
      }),
  };
});

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const lockedError = (): Error => sqliteError('SQLITE_BUSY', 'database is locked');

/**
 * Makes SQLite refuse the first `refusals` switches to write-ahead logging with `error`, on any
 * connection, the way a racing process makes it refuse them. Everything else goes to the real
 * connection, and so to real SQLite. Returns how many switches were asked for.
 */
function refuseWalSwitch(refusals: number, error: () => Error = lockedError): { asked: number } {
  const real = Database.prototype.pragma;
  const counter = { asked: 0 };
  vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: Database.Database,
    source: string,
    options?: Database.PragmaOptions,
  ) {
    if (WAL_SWITCH.test(source)) {
      counter.asked += 1;
      if (counter.asked <= refusals) throw error();
    }
    return real.call(this, source, options);
  } as typeof real);
  return counter;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function journalModeOf(path: string): unknown {
  return withReadonlyDatabase(path, (db) => db.pragma('journal_mode', { simple: true }));
}

describe('the switch to write-ahead logging', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-wal-switch-'));
    dbPath = join(tempDir, 'vault.db');
    createLegacyDatabase(dbPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    scenario.busyTimeout = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('on an adapter opened without it', () => {
    it('is tried again while SQLite refuses it as locked, and done once it is free', async () => {
      const adapter = await BetterSqliteAdapter.create(dbPath, { walMode: false });
      const switches = refuseWalSwitch(TRANSIENT_FAILURES);
      try {
        adapter.enableWriteAheadLog();
      } finally {
        adapter.close();
      }

      expect(switches.asked).toBe(TRANSIENT_FAILURES + 1);
      expect(journalModeOf(dbPath)).toBe('wal');
    });

    it('gives up with the lock error once the busy timeout has passed', async () => {
      const adapter = await BetterSqliteAdapter.create(dbPath, {
        walMode: false,
        busyTimeout: SHORT_BUSY_TIMEOUT_MS,
      });
      const switches = refuseWalSwitch(Infinity);
      const startedAt = Date.now();
      try {
        expect(() => adapter.enableWriteAheadLog()).toThrow(/database is locked/);
      } finally {
        adapter.close();
      }

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SHORT_BUSY_TIMEOUT_MS);
      // How many tries fit in the window depends on the speed of the machine (a slow runner managed
      // two); what matters is that it tried again at all before giving up.
      expect(switches.asked).toBeGreaterThanOrEqual(2);
      expect(journalModeOf(dbPath)).toBe('delete');
    });

    it('does not try again after a failure that is not a lock', async () => {
      const adapter = await BetterSqliteAdapter.create(dbPath, { walMode: false });
      const switches = refuseWalSwitch(Infinity, () =>
        sqliteError('SQLITE_IOERR', 'disk I/O error'),
      );
      try {
        expect(() => adapter.enableWriteAheadLog()).toThrow(/disk I\/O error/);
      } finally {
        adapter.close();
      }

      expect(switches.asked).toBe(1);
    });
  });

  describe('when the engine opens a database that is still in rollback-journal mode', () => {
    it('opens and migrates it although the first switches are refused', async () => {
      const switches = refuseWalSwitch(TRANSIENT_FAILURES);

      (await SqliteEngine.create(dbPath)).close();

      expect(switches.asked).toBeGreaterThan(TRANSIENT_FAILURES);
      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(journalModeOf(dbPath)).toBe('wal');
    });

    it('reports a lock that outlasts the wait as DatabaseLockedError, with the file untouched', async () => {
      scenario.busyTimeout = SHORT_BUSY_TIMEOUT_MS;
      const bytesBefore = sha256(dbPath);
      refuseWalSwitch(Infinity);

      const failure = await SqliteEngine.create(dbPath).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      // Nothing had been written when the switch failed, so this is where "not modified" is true;
      // and the message must not claim that the wait was repeated when it may not have been.
      expect(failure!.message).toMatch(/database not modified/i);
      expect(failure!.message).not.toMatch(/retries/i);
      expect(sha256(dbPath)).toBe(bytesBefore);
      expect(recordedVersions(dbPath)).toEqual([1, 2]);
    });
  });
});
