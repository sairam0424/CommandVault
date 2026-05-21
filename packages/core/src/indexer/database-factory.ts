import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';
import { SqlJsAdapter } from './sqljs-adapter.js';

/**
 * Creates the appropriate database adapter based on environment.
 * Prefers better-sqlite3 (native, WAL, fast) but falls back to sql.js
 * when native dependencies are unavailable.
 */
export async function createDatabaseAdapter(
  dbPath: string,
  options?: DatabaseAdapterOptions,
): Promise<DatabaseAdapter> {
  try {
    await import('better-sqlite3');
    const { BetterSqliteAdapter } = await import('./better-sqlite-adapter.js');
    return BetterSqliteAdapter.create(dbPath, options);
  } catch {
    return SqlJsAdapter.create(dbPath, options);
  }
}
