import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';
import { SqlJsAdapter } from './sqljs-adapter.js';

const IN_MEMORY_PATH = ':memory:';

/**
 * Creates the appropriate database adapter based on environment.
 * Prefers better-sqlite3 (native, WAL, fast) but falls back to sql.js
 * when the native addon cannot be loaded.
 *
 * The fallback is decided by a probe, not by a catch around the real open, so a genuine
 * failure on the database path (permissions, disk full, locked file) still reaches the caller.
 */
export async function createDatabaseAdapter(
  dbPath: string,
  options?: DatabaseAdapterOptions,
): Promise<DatabaseAdapter> {
  if (!(await isNativeAddonLoadable())) {
    return SqlJsAdapter.create(dbPath, options);
  }
  const { BetterSqliteAdapter } = await import('./better-sqlite-adapter.js');
  return BetterSqliteAdapter.create(dbPath, options);
}

/**
 * better-sqlite3 loads its .node binary lazily in the Database constructor, so importing the
 * module proves nothing: a missing or ABI-mismatched binary only fails on the first `new`.
 * An in-memory database touches no file, so any failure here is an addon-load failure.
 */
async function isNativeAddonLoadable(): Promise<boolean> {
  try {
    const { default: Database } = await import('better-sqlite3');
    new Database(IN_MEMORY_PATH).close();
    return true;
  } catch {
    // Deliberate: an unloadable addon is the expected trigger for the sql.js fallback.
    return false;
  }
}
