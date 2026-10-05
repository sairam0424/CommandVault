import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { BetterSqliteAdapter } from '../indexer/better-sqlite-adapter.js';
import { createDatabaseAdapter } from '../indexer/database-factory.js';
import {
  DatabaseCorruptError,
  DatabaseIoError,
  DatabaseLockedError,
  NativeAddonUnavailableError,
  type DatabaseOpenError,
} from '../indexer/db-errors.js';
import {
  backupNames,
  captureStderr,
  countFavorites,
  makeTempDir,
  seedDatabase,
  snapshotDir,
  writeGarbage,
  type StderrCapture,
} from './db-open-helpers.js';

// better-sqlite3 loads its native addon lazily, inside the first `new Database()`. The mock below
// makes that constructor fail the way a Node switch does, or lets a test intervene in the middle
// of an open, while every other path still runs the real driver.
const scenario = vi.hoisted(() => ({
  constructorFailure: undefined as Error | undefined,
  /** Fails only the next construction, then clears itself. */
  nextConstructorFailure: undefined as Error | undefined,
  pragmaFailure: undefined as Error | undefined,
  /** Fails only the next pragma call, then clears itself. */
  nextPragmaFailure: undefined as Error | undefined,
  beforeConstruct: undefined as (() => void) | undefined,
  /** How many times the driver was asked to open a database, whether or not it succeeded. */
  constructions: 0,
  /** Every real connection that was opened, so a test can see which ones are still open. */
  instances: [] as Array<{ readonly open: boolean }>,
  openHandlesWhenQuarantining: undefined as number | undefined,
}));

vi.mock('better-sqlite3', async (importOriginal) => {
  const original = (await importOriginal()) as { default: typeof BetterSqlite3 };
  const RealDatabase = original.default;
  class ScriptedDatabase extends RealDatabase {
    constructor(...args: ConstructorParameters<typeof RealDatabase>) {
      scenario.constructions += 1;
      scenario.beforeConstruct?.();
      const once = scenario.nextConstructorFailure;
      scenario.nextConstructorFailure = undefined;
      if (once !== undefined) throw once;
      if (scenario.constructorFailure !== undefined) throw scenario.constructorFailure;
      super(...args);
      scenario.instances.push(this);
    }

    override pragma(source: string, options?: BetterSqlite3.PragmaOptions): unknown {
      const once = scenario.nextPragmaFailure;
      scenario.nextPragmaFailure = undefined;
      if (once !== undefined) throw once;
      if (scenario.pragmaFailure !== undefined) throw scenario.pragmaFailure;
      return super.pragma(source, options);
    }
  }
  return { ...original, default: ScriptedDatabase };
});

// Records how many connections are still open at the moment a corrupt file is about to be repaired.
vi.mock('../indexer/quarantine.js', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('../indexer/quarantine.js');
  return {
    ...original,
    quarantineCorruptDatabase: (...args: Parameters<typeof original.quarantineCorruptDatabase>) => {
      scenario.openHandlesWhenQuarantining = scenario.instances.filter((db) => db.open).length;
      return original.quarantineCorruptDatabase(...args);
    },
  };
});

// A corrupt file is judged again when it changed under a failed attempt, but not forever.
const EXPECTED_OPEN_ATTEMPTS = 3;
const BUILT_ABI = '127';
const RUNNING_ABI = '147';
const ABI_MISMATCH_MESSAGE =
  "The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\n" +
  `NODE_MODULE_VERSION ${BUILT_ABI}. This version of Node.js requires\n` +
  `NODE_MODULE_VERSION ${RUNNING_ABI}. Please try re-compiling or re-installing\nthe module.`;

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('opening with a driver that fails: the database file is never touched', () => {
  let dir: string;
  let dbPath: string;
  let stderr: StderrCapture;

  beforeEach(() => {
    dir = makeTempDir('open-addon');
    dbPath = join(dir, 'vault.db');
    stderr = captureStderr();
    seedDatabase(dbPath, { wal: true, rows: 8 });
    // Seeding used the scripted driver too; count only what the test itself opens.
    scenario.constructions = 0;
    scenario.instances = [];
  });

  afterEach(() => {
    scenario.constructorFailure = undefined;
    scenario.nextConstructorFailure = undefined;
    scenario.pragmaFailure = undefined;
    scenario.nextPragmaFailure = undefined;
    scenario.beforeConstruct = undefined;
    scenario.constructions = 0;
    scenario.instances = [];
    scenario.openHandlesWhenQuarantining = undefined;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unloadable native addon as NativeAddonUnavailableError, database byte-identical', async () => {
    const before = snapshotDir(dir);
    scenario.constructorFailure = codedError(ABI_MISMATCH_MESSAGE, 'ERR_DLOPEN_FAILED');

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(snapshotDir(dir)).toEqual(before);
    expect(backupNames(dir)).toEqual([]);
    expect(failure).toBeInstanceOf(NativeAddonUnavailableError);
    const message = (failure as DatabaseOpenError).message;
    expect(message).toContain(dbPath);
    expect(message).toMatch(/database not modified/i);
    expect(message).toContain('npm rebuild better-sqlite3');
    expect(message).toContain('pnpm approve-builds');
    expect(message).toContain(`ABI ${BUILT_ABI}`);
    expect(message).toContain(`ABI ${RUNNING_ABI}`);
    expect((failure as DatabaseOpenError).cause).toBe(scenario.constructorFailure);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it('recognises a missing bindings file by its message when no error code is set', async () => {
    const before = snapshotDir(dir);
    scenario.constructorFailure = new Error('Could not locate the bindings file. Tried: /x/y.node');

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(snapshotDir(dir)).toEqual(before);
    expect(backupNames(dir)).toEqual([]);
    expect(failure).toBeInstanceOf(NativeAddonUnavailableError);
    expect((failure as Error).message).toContain(`ABI ${process.versions.modules}`);
  });

  it('does not create a database file when the addon cannot load and none existed', async () => {
    rmSync(join(dir, 'vault.db'));
    scenario.constructorFailure = codedError(ABI_MISMATCH_MESSAGE, 'ERR_DLOPEN_FAILED');

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(readdirSync(dir)).toEqual([]);
    expect(failure).toBeInstanceOf(NativeAddonUnavailableError);
  });

  it('rethrows an unrecognised error as the very same object and changes nothing', async () => {
    const before = snapshotDir(dir);
    const weird = new Error('weird');
    scenario.constructorFailure = weird;

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(snapshotDir(dir)).toEqual(before);
    expect(backupNames(dir)).toEqual([]);
    expect(failure).toBe(weird);
  });

  it('rethrows an unrecognised SQLite result code raised while configuring', async () => {
    const before = snapshotDir(dir);
    const unexpected = codedError('constraint failed', 'SQLITE_CONSTRAINT');
    scenario.pragmaFailure = unexpected;

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(snapshotDir(dir)).toEqual(before);
    expect(backupNames(dir)).toEqual([]);
    expect(failure).toBe(unexpected);
  });

  it('reports a full disk as DatabaseIoError and leaves the file where it is', async () => {
    const before = snapshotDir(dir);
    scenario.constructorFailure = codedError('no space left on device', 'ENOSPC');

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(snapshotDir(dir)).toEqual(before);
    expect(backupNames(dir)).toEqual([]);
    expect(failure).toBeInstanceOf(DatabaseIoError);
  });

  it('does not quarantine a file that another process replaced while this open was failing', async () => {
    const replacement = join(dir, 'replacement.db');
    seedDatabase(replacement, { rows: 11 });
    // Another process quarantined the corrupt file and created a healthy one at the same path,
    // after this process read the identity of the file it is about to open.
    scenario.beforeConstruct = () => {
      scenario.beforeConstruct = undefined;
      renameSync(replacement, dbPath);
    };
    scenario.nextConstructorFailure = codedError('file is not a database', 'SQLITE_NOTADB');

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();

    expect(backupNames(dir)).toEqual([]);
    expect(countFavorites(dbPath)).toBe(11);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it('judges a file that changes under every attempt a bounded number of times, changing nothing', async () => {
    // Each attempt sees a different file than the one it started with, so no repair is ever safe.
    const sizeBefore = statSync(dbPath).size;
    scenario.beforeConstruct = () => appendFileSync(dbPath, 'x');
    scenario.constructorFailure = codedError('file is not a database', 'SQLITE_NOTADB');

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(failure).toBeInstanceOf(DatabaseCorruptError);
    expect(scenario.constructions).toBe(EXPECTED_OPEN_ATTEMPTS);
    expect(statSync(dbPath).size).toBe(sizeBefore + EXPECTED_OPEN_ATTEMPTS);
    expect(backupNames(dir)).toEqual([]);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it('retries contention on the open that follows a repair, like on any other open', async () => {
    const garbage = writeGarbage(dbPath);
    // The first construction is the real one and reaches the garbage. The one after the repair meets a
    // lock once, as it does when another process opens the fresh file at the same moment.
    scenario.beforeConstruct = () => {
      if (scenario.constructions === 2) {
        scenario.nextPragmaFailure = codedError('database is locked', 'SQLITE_BUSY');
      }
    };

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.close();

    expect(scenario.constructions).toBe(3);
    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(garbage)).toBe(true);
  });

  it('closes the connection of an open that failed, whatever the reason', async () => {
    scenario.pragmaFailure = codedError('constraint failed', 'SQLITE_CONSTRAINT');

    await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(scenario.instances).toHaveLength(1);
    expect(scenario.instances.every((db) => !db.open)).toBe(true);
  });

  it('closes the failed connection before it quarantines a corrupt file', async () => {
    writeGarbage(dbPath);

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();

    // The repair empties the file in place and deletes its -wal and -shm; a connection still open
    // on them would go on using the old ones (see quarantine-openers.ts). The handle has to go first.
    expect(scenario.openHandlesWhenQuarantining).toBe(0);
    expect(scenario.instances).toHaveLength(2);
  });

  it.each([
    ['a full disk', codedError('no space left on device', 'ENOSPC')],
    ['a permission error', codedError('permission denied', 'EACCES')],
    ['an unloadable addon', codedError(ABI_MISMATCH_MESSAGE, 'ERR_DLOPEN_FAILED')],
    ['an unrecognised error', new Error('weird')],
  ])('tries once and gives up on %s: only contention is worth retrying', async (_label, error) => {
    scenario.constructorFailure = error;

    await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(scenario.constructions).toBe(1);
  });

  it('retries a held lock a bounded number of times, then reports it', async () => {
    scenario.constructorFailure = codedError('database is locked', 'SQLITE_BUSY');

    const failure = await failureOf(() => BetterSqliteAdapter.create(dbPath));

    expect(failure).toBeInstanceOf(DatabaseLockedError);
    expect(scenario.constructions).toBeGreaterThan(1);
    expect(scenario.constructions).toBeLessThanOrEqual(5);
  });

  it.each(['SQLITE_IOERR_DELETE_NOENT'])(
    'opens on the next attempt when %s shows another process moved a file away mid-open',
    async (code) => {
      const before = snapshotDir(dir);
      scenario.nextPragmaFailure = codedError('disk I/O error', code);

      const adapter = await BetterSqliteAdapter.create(dbPath);
      expect(adapter.queryOne<{ c: number }>('SELECT count(*) AS c FROM favorites')?.c).toBe(8);
      adapter.close();

      expect(scenario.constructions).toBe(2);
      expect(backupNames(dir)).toEqual([]);
      expect(Object.keys(snapshotDir(dir))).toEqual(Object.keys(before));
    },
  );

  it('lets NativeAddonUnavailableError out of createDatabaseAdapter instead of switching to sql.js', async () => {
    const before = snapshotDir(dir);
    scenario.constructorFailure = codedError(ABI_MISMATCH_MESSAGE, 'ERR_DLOPEN_FAILED');

    const failure = await failureOf(() => createDatabaseAdapter(dbPath));

    expect(snapshotDir(dir)).toEqual(before);
    expect(failure).toBeInstanceOf(NativeAddonUnavailableError);
  });
});
