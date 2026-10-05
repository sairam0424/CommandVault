import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';
import { classifyOpenError, toOpenError } from './db-errors.js';
import { fileFingerprint, quarantineCorruptDatabase } from './quarantine.js';
import { OWNER_ONLY_MODE } from './quarantine-fs.js';

const PERSIST_DEBOUNCE_MS = 2000;

interface SqlJsModule {
  readonly Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
}

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
    ) => Promise<SqlJsModule>;
    const SQL = await initSqlJs();

    const db = openStoredDatabase(SQL, dbPath);

    if (options.walMode) {
      db.run('PRAGMA journal_mode = WAL');
    } else {
      db.run('PRAGMA journal_mode = DELETE');
    }

    if (options.busyTimeout) {
      db.run(`PRAGMA busy_timeout = ${options.busyTimeout}`);
    }

    const adapter = new SqlJsAdapter(db, dbPath);
    writeFirstCopy(adapter, dbPath);
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
    writeFileSync(this.path, Buffer.from(data), { mode: OWNER_ONLY_MODE });
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

/** The first write can fail on a file the user may read but not change: say so, in typed form. */
function writeFirstCopy(adapter: SqlJsAdapter, dbPath: string): void {
  try {
    adapter.persist();
  } catch (error) {
    adapter.close();
    throw toOpenError(error, dbPath);
  }
}

/** Reads the file into memory. SQLite only judges its contents on the first statement, so probe. */
function readStoredDatabase(SQL: SqlJsModule, dbPath: string): SqlJsDatabase {
  if (!existsSync(dbPath)) {
    return new SQL.Database();
  }
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    db.exec('SELECT 1 FROM sqlite_master LIMIT 1');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Loads the database. The file is copied under a backup name and emptied in place only when SQLite
 * itself reports it as corrupt; an unreadable file or any unrecognised failure leaves it exactly
 * as it is.
 */
function openStoredDatabase(SQL: SqlJsModule, dbPath: string): SqlJsDatabase {
  try {
    return readOrQuarantine(SQL, dbPath);
  } catch (error) {
    throw toOpenError(error, dbPath);
  }
}

function readOrQuarantine(SQL: SqlJsModule, dbPath: string): SqlJsDatabase {
  const failedFingerprint = fileFingerprint(dbPath);
  try {
    return readStoredDatabase(SQL, dbPath);
  } catch (error) {
    if (classifyOpenError(error) !== 'corrupt') throw error;
    // If another process replaced the file meanwhile, nothing is changed and the read below judges
    // whatever is there now.
    const backupPath = quarantineCorruptDatabase(dbPath, failedFingerprint, error);
    return backupPath === undefined ? readStoredDatabase(SQL, dbPath) : new SQL.Database();
  }
}
