import type { DatabaseAdapter } from '../indexer/database-adapter.js';

/**
 * Wraps a real adapter so a test can watch, or interfere with, the calls an engine makes to it.
 * Everything is delegated to the real adapter (and so to real SQLite); a hook only sees the call
 * first and can replace a query's rows or make a statement fail.
 */
export interface AdapterHooks {
  /** Rows to answer `sql` with instead of asking the database; undefined lets the query through. */
  readonly answerQuery?: (sql: string) => unknown[] | undefined;
  /** Called before each statement runs; throw to make it fail. */
  readonly beforeExecute?: (sql: string) => void;
  /** Called before each query runs; throw to make it fail. */
  readonly beforeQuery?: (sql: string) => void;
  /** Called when a transaction starts, with the options it was asked for. */
  readonly onTransaction?: (options: { readonly mode?: string } | undefined) => void;
  /** Called once the real connection has been closed. */
  readonly onClose?: () => void;
  /** The path the wrapper reports, for a test about how an engine treats a kind of path. */
  readonly reportedPath?: string;
}

export function instrumentAdapter(adapter: DatabaseAdapter, hooks: AdapterHooks): DatabaseAdapter {
  return {
    path: hooks.reportedPath ?? adapter.path,
    queryAll: <T>(sql: string, params?: Record<string, unknown>): T[] => {
      hooks.beforeQuery?.(sql);
      const answer = hooks.answerQuery?.(sql);
      return answer === undefined ? adapter.queryAll<T>(sql, params) : (answer as T[]);
    },
    queryOne: <T>(sql: string, params?: Record<string, unknown>): T | undefined => {
      hooks.beforeQuery?.(sql);
      const answer = hooks.answerQuery?.(sql);
      return answer === undefined ? adapter.queryOne<T>(sql, params) : (answer[0] as T | undefined);
    },
    execute: (sql, params) => {
      hooks.beforeExecute?.(sql);
      adapter.execute(sql, params);
    },
    transaction: <T>(fn: () => T, options?: { readonly mode?: 'deferred' | 'immediate' }): T => {
      hooks.onTransaction?.(options);
      return adapter.transaction(fn, options);
    },
    enableWriteAheadLog: () => adapter.enableWriteAheadLog(),
    backupTo: (destination) => adapter.backupTo(destination),
    close: () => {
      try {
        adapter.close();
      } finally {
        hooks.onClose?.();
      }
    },
  };
}
