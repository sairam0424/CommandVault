import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';
import { SqlJsAdapter } from './sqljs-adapter.js';

type NativeAdapterClass = typeof import('./better-sqlite-adapter.js').BetterSqliteAdapter;

/**
 * Creates the appropriate database adapter based on environment.
 * Prefers better-sqlite3 (native, WAL, fast) but falls back to sql.js
 * when native dependencies are unavailable.
 *
 * The fallback only covers a driver that cannot be imported at all. A driver that imports but
 * fails to open the database (native addon built for another Node, lock, permissions) must
 * surface its typed error: switching to sql.js there would hide a broken install from the user.
 */
export async function createDatabaseAdapter(
  dbPath: string,
  options?: DatabaseAdapterOptions,
): Promise<DatabaseAdapter> {
  const NativeAdapter = await loadNativeAdapter();
  if (NativeAdapter === undefined) {
    return SqlJsAdapter.create(dbPath, options);
  }
  return NativeAdapter.create(dbPath, options);
}

async function loadNativeAdapter(): Promise<NativeAdapterClass | undefined> {
  try {
    await import('better-sqlite3');
    const { BetterSqliteAdapter } = await import('./better-sqlite-adapter.js');
    return BetterSqliteAdapter;
  } catch {
    return undefined;
  }
}
