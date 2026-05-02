declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  interface Statement {
    bind(params?: Record<string, unknown> | unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
    free(): void;
    reset(): void;
    run(params?: Record<string, unknown> | unknown[]): void;
  }

  interface Database {
    run(sql: string, params?: Record<string, unknown> | unknown[]): void;
    exec(sql: string, params?: Record<string, unknown> | unknown[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export type { Database, Statement, QueryExecResult, SqlJsStatic };
  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}

declare module 'sql.js/dist/sql-asm.js' {
  import type { SqlJsStatic } from 'sql.js';
  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
