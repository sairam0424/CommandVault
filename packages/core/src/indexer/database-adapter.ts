/**
 * Abstract database adapter interface for CommandVault storage.
 * Supports both better-sqlite3 (native) and sql.js (fallback) backends.
 */

export interface DatabaseAdapterOptions {
  /**
   * Switch to WAL journal mode as part of opening (default true for better-sqlite3, ignored by
   * sql.js). A caller that has to look at the file before anything is written to it, journal mode
   * included, passes false and calls `enableWriteAheadLog()` afterwards.
   */
  readonly walMode?: boolean;
  /** Milliseconds to wait when the database is locked (default 10000) */
  readonly busyTimeout?: number;
  /** Open the database in read-only mode */
  readonly readonly?: boolean;
}

export interface TransactionOptions {
  /**
   * `immediate` takes the write lock when the transaction starts, so every statement in it sees
   * the state it will change, and waits for a writer rather than failing half way through.
   * `deferred` (the default) takes it at the first write.
   */
  readonly mode?: 'deferred' | 'immediate';
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

  /** Wrap a set of operations in an atomic transaction. Transactions do not nest. */
  transaction<T>(fn: () => T, options?: TransactionOptions): T;

  /**
   * Switch the file to write-ahead logging, which rewrites its header when it was not in it yet.
   * Does nothing for a backend that has no journal to switch (sql.js writes the file whole).
   * Waits for a lock another process holds, up to the busy timeout, and then throws the lock error.
   */
  enableWriteAheadLog(): void;

  /**
   * Write a consistent copy of the whole database to `destination`, which must not exist yet. The
   * copy is readable by its owner only from its first byte. Called inside a transaction, it holds
   * the state the transaction started from. A database with a damaged page is copied page for page,
   * damage included, instead of failing.
   */
  backupTo(destination: string): void;

  /** Close the database connection and release resources */
  close(): void;
}
