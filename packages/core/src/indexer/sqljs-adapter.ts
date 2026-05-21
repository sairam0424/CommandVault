import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';

const PERSIST_DEBOUNCE_MS = 2000;

export class SqlJsAdapter implements DatabaseAdapter {
  readonly path: string;
  private readonly db: SqlJsDatabase;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.path = dbPath;
  }

  static async create(dbPath: string, options: DatabaseAdapterOptions = {}): Promise<SqlJsAdapter> {
    const parentDir = dirname(dbPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    const sqlAsmModule = await import('sql.js/dist/sql-asm.js');
    const initSqlJs = (sqlAsmModule.default ?? sqlAsmModule) as (
      config?: Record<string, unknown>,
    ) => Promise<{ Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase }>;
    const SQL = await initSqlJs();

    let db: SqlJsDatabase;
    if (existsSync(dbPath)) {
      try {
        const buffer = readFileSync(dbPath);
        db = new SQL.Database(buffer);
      } catch {
        const corruptPath = dbPath.replace(/\.db$/, '.corrupt');
        renameSync(dbPath, corruptPath);
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }

    if (options.walMode) {
      db.run('PRAGMA journal_mode = WAL');
    } else {
      db.run('PRAGMA journal_mode = DELETE');
    }

    if (options.busyTimeout) {
      db.run(`PRAGMA busy_timeout = ${options.busyTimeout}`);
    }

    const adapter = new SqlJsAdapter(db, dbPath);
    adapter.persist();
    return adapter;
  }

  queryAll<T>(sql: string, params: Record<string, unknown> = {}): T[] {
    const stmt = this.db.prepare(sql);
    if (Object.keys(params).length > 0) {
      stmt.bind(params as Record<string, string | number | null | Uint8Array>);
    }
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  queryOne<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
    const results = this.queryAll<T>(sql, params);
    return results[0];
  }

  execute(sql: string, params: Record<string, unknown> = {}): void {
    this.db.run(sql, params as Record<string, string | number | null | Uint8Array>);
    this.dirty = true;
    this.persistDebounced();
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.dirty = true;
      this.persistDebounced();
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.flushPersist();
    this.db.close();
  }

  persist(): void {
    const data = this.db.export();
    writeFileSync(this.path, Buffer.from(data), { mode: 0o600 });
    this.dirty = false;
  }

  private persistDebounced(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) {
        this.persist();
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  private flushPersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this.persist();
    }
  }
}
