import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';

const DEFAULT_BUSY_TIMEOUT = 5000;

export class BetterSqliteAdapter implements DatabaseAdapter {
  readonly path: string;
  private readonly db: Database.Database;

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.path = dbPath;
  }

  static async create(
    dbPath: string,
    options?: DatabaseAdapterOptions,
  ): Promise<BetterSqliteAdapter> {
    return new BetterSqliteAdapter(openDatabase(dbPath, options), dbPath);
  }

  queryAll<T>(sql: string, params: Record<string, unknown> = {}): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(stripParamPrefix(params)) as T[];
  }

  queryOne<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(stripParamPrefix(params)) as T | undefined;
  }

  execute(sql: string, params: Record<string, unknown> = {}): void {
    const hasParams = Object.keys(params).length > 0;
    if (hasParams) {
      const stmt = this.db.prepare(sql);
      stmt.run(stripParamPrefix(params));
    } else {
      // DDL, PRAGMAs, and multi-statement SQL require db.exec (not prepare)
      this.db.exec(sql); // better-sqlite3 Database.exec, not child_process
    }
  }

  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  close(): void {
    this.db.close();
  }
}

/** better-sqlite3 expects param keys without $ prefix (SQL uses $id, binding uses id) */
function stripParamPrefix(params: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    stripped[key.startsWith('$') ? key.slice(1) : key] = value;
  }
  return stripped;
}

function openDatabase(dbPath: string, options?: DatabaseAdapterOptions): Database.Database {
  const walMode = options?.walMode ?? true;
  const busyTimeout = options?.busyTimeout ?? DEFAULT_BUSY_TIMEOUT;
  const readonly = options?.readonly ?? false;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(dbPath)) {
    try {
      return configureDatabase(new Database(dbPath, { readonly }), walMode, busyTimeout);
    } catch {
      // DB file is corrupt — archive it and start fresh
      const timestamp = Date.now();
      const corruptPath = `${dbPath}.corrupt.${timestamp}.bak`;
      renameSync(dbPath, corruptPath);
    }
  }

  const db = configureDatabase(new Database(dbPath), walMode, busyTimeout);
  chmodSync(dbPath, 0o600);
  return db;
}

function configureDatabase(
  db: Database.Database,
  walMode: boolean,
  busyTimeout: number,
): Database.Database {
  if (walMode) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma('foreign_keys = ON');
  return db;
}
