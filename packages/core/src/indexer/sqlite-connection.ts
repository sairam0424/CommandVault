import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Database as SqlJsDatabase } from 'sql.js';
import { runMigrations } from './migrations.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    description TEXT NOT NULL,
    file_path TEXT NOT NULL,
    tags TEXT NOT NULL,
    metadata TEXT NOT NULL,
    content TEXT NOT NULL,
    last_modified TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_tags (
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(entry_id, tag)
  );

  CREATE TABLE IF NOT EXISTS scan_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export class SqliteConnection {
  readonly db: SqlJsDatabase;
  private readonly dbPath: string;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<SqliteConnection> {
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
        // DB file is corrupt — archive it and start fresh
        const corruptPath = dbPath.replace(/\.db$/, '.corrupt');
        renameSync(dbPath, corruptPath);
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }
    db.run('PRAGMA journal_mode = DELETE');
    db.exec(SCHEMA);
    const conn = new SqliteConnection(db, dbPath);
    runMigrations(db);
    conn.persist();
    return conn;
  }

  queryAll<T>(sql: string, params: Record<string, unknown> = {}): T[] {
    const stmt = this.db.prepare(sql);
    if (Object.keys(params).length > 0) {
      stmt.bind(params);
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
  }

  persist(): void {
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data), { mode: 0o600 });
  }

  close(): void {
    this.persist();
    this.db.close();
  }
}
