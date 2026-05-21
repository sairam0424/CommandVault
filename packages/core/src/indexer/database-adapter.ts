/**
 * Abstract database adapter interface for CommandVault storage.
 * Supports both better-sqlite3 (native) and sql.js (fallback) backends.
 */

export interface DatabaseAdapterOptions {
  /** Enable WAL journal mode (default true for better-sqlite3, ignored by sql.js) */
  readonly walMode?: boolean;
  /** Milliseconds to wait when the database is locked (default 5000) */
  readonly busyTimeout?: number;
  /** Open the database in read-only mode */
  readonly readonly?: boolean;
}

export interface DatabaseAdapter {
  /** The database file path */
  readonly path: string;

  /** Execute a query and return all matching rows */
  queryAll<T>(sql: string, params?: Record<string, unknown>): T[];

  /** Execute a query and return the first row, or undefined if none match */
  queryOne<T>(sql: string, params?: Record<string, unknown>): T | undefined;

  /** Execute a statement that modifies data (INSERT, UPDATE, DELETE) */
  execute(sql: string, params?: Record<string, unknown>): void;

  /** Wrap a set of operations in an atomic transaction */
  transaction<T>(fn: () => T): T;

  /** Close the database connection and release resources */
  close(): void;
}
