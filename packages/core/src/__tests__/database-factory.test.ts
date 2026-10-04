import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseAdapter } from '../indexer/database-adapter.js';

// better-sqlite3 loads its native addon lazily inside the Database constructor, so importing
// the module succeeds even when the .node binary is missing or built for another ABI. These
// tests drive both failure points (import and construct) through a wrapper around the real
// module, and check that only addon-load failures reach the sql.js fallback.

const IN_MEMORY_PATH = ':memory:';
const ADDON_ERROR_MESSAGE = 'The module was compiled against a different Node.js ABI version';

interface ConstructedDatabase {
  readonly path: unknown;
  closeCalls: number;
}

type DatabaseConstructor = new (...args: unknown[]) => { close(): unknown };

/** Replaces better-sqlite3 for the next import; `fileOpenError` only fires for on-disk paths. */
function mockBetterSqlite3(behavior: {
  readonly addonError?: Error;
  readonly fileOpenError?: Error;
}): ConstructedDatabase[] {
  const constructed: ConstructedDatabase[] = [];
  vi.doMock('better-sqlite3', async (importOriginal) => {
    const original = await importOriginal<{ default: DatabaseConstructor }>();
    const Instrumented = function (this: unknown, ...args: unknown[]) {
      if (behavior.addonError) throw behavior.addonError;
      if (behavior.fileOpenError && args[0] !== IN_MEMORY_PATH) throw behavior.fileOpenError;
      const record: ConstructedDatabase = { path: args[0], closeCalls: 0 };
      constructed.push(record);
      const real = new original.default(...args);
      const realClose = real.close.bind(real);
      real.close = () => {
        record.closeCalls += 1;
        return realClose();
      };
      return real;
    };
    return { default: Object.assign(Instrumented, original.default) };
  });
  return constructed;
}

/** Loaded after `vi.doMock` so each test sees its own better-sqlite3 behavior. */
async function loadFactory() {
  const [{ createDatabaseAdapter }, { SqlJsAdapter }] = await Promise.all([
    import('../indexer/database-factory.js'),
    import('../indexer/sqljs-adapter.js'),
  ]);
  return { createDatabaseAdapter, SqlJsAdapter };
}

describe('createDatabaseAdapter', () => {
  let tempDir: string;
  let dbPath: string;
  const opened: DatabaseAdapter[] = [];

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), 'cv-db-factory-'));
    dbPath = join(tempDir, 'index.db');
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) adapter.close();
    vi.doUnmock('better-sqlite3');
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the native adapter when the addon loads', async () => {
    mockBetterSqlite3({});
    const { createDatabaseAdapter } = await loadFactory();
    const { BetterSqliteAdapter } = await import('../indexer/better-sqlite-adapter.js');

    const adapter = await createDatabaseAdapter(dbPath);
    opened.push(adapter);

    expect(adapter).toBeInstanceOf(BetterSqliteAdapter);
  });

  it('falls back to sql.js when constructing a database throws because the addon cannot load', async () => {
    mockBetterSqlite3({ addonError: new Error(ADDON_ERROR_MESSAGE) });
    const { createDatabaseAdapter, SqlJsAdapter } = await loadFactory();

    const adapter = await createDatabaseAdapter(dbPath);
    opened.push(adapter);

    expect(adapter).toBeInstanceOf(SqlJsAdapter);
  });

  it('falls back to sql.js when importing better-sqlite3 itself fails', async () => {
    vi.doMock('better-sqlite3', () => {
      throw new Error("Cannot find module 'better-sqlite3'");
    });
    const { createDatabaseAdapter, SqlJsAdapter } = await loadFactory();

    const adapter = await createDatabaseAdapter(dbPath);
    opened.push(adapter);

    expect(adapter).toBeInstanceOf(SqlJsAdapter);
  });

  it('does not hide a non-addon open failure behind the sql.js fallback', async () => {
    const permissionError = Object.assign(new Error('EACCES: permission denied, open'), {
      code: 'EACCES',
    });
    mockBetterSqlite3({ fileOpenError: permissionError });
    const { createDatabaseAdapter, SqlJsAdapter } = await loadFactory();
    const sqlJsCreate = vi.spyOn(SqlJsAdapter, 'create');

    await expect(createDatabaseAdapter(dbPath)).rejects.toBe(permissionError);
    expect(sqlJsCreate).not.toHaveBeenCalled();
  });

  it('probes with a closed in-memory database and leaves no extra files', async () => {
    const constructed = mockBetterSqlite3({});
    const { createDatabaseAdapter } = await loadFactory();

    const adapter = await createDatabaseAdapter(dbPath);
    opened.push(adapter);

    const [probe, real] = constructed;
    expect(constructed).toHaveLength(2);
    expect(probe).toMatchObject({ path: IN_MEMORY_PATH, closeCalls: 1 });
    expect(real).toMatchObject({ path: dbPath, closeCalls: 0 });
    const files = await readdir(tempDir);
    expect(files.every((name) => name.startsWith('index.db'))).toBe(true);
  });
});
