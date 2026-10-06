import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';
import type {
  DatabaseAdapter,
  DatabaseAdapterOptions,
  TransactionOptions,
} from './database-adapter.js';
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

    const { db, isFromFile } = openStoredDatabase(SQL, dbPath);

    if (options.walMode) {
      db.run('PRAGMA journal_mode = WAL');
    } else {
      db.run('PRAGMA journal_mode = DELETE');
    }

    if (options.busyTimeout) {
      db.run(`PRAGMA busy_timeout = ${options.busyTimeout}`);
    }

    const adapter = new SqlJsAdapter(db, dbPath);
    ensureFileIsWritable(adapter, dbPath, isFromFile);
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

  transaction<T>(fn: () => T, options?: TransactionOptions): T {
    this.db.run(options?.mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.dirty = true;
      this.persistDebounced();
      return result;
    } catch (error) {
      this.rollBack();
      throw error;
    }
  }

  enableWriteAheadLog(): void {
    // The database lives in memory and is written to its file whole: there is no journal to switch.
  }

  backupTo(destination: string): void {
    // export() reopens the database, which would end a transaction that is running, so the copy is
    // the file itself: whatever the last persist wrote.
    if (this.dirty) {
      throw new Error('cannot back up a database that has changes not yet saved to its file');
    }
    writeFileSync(destination, readFileSync(this.path), { flag: 'wx', mode: OWNER_ONLY_MODE });
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

  private rollBack(): void {
    try {
      this.db.run('ROLLBACK');
    } catch {
      // SQLite rolls a transaction back by itself after some failures (a full disk, for one), and
      // then there is nothing left to roll back. The error being rethrown is the one that matters.
    }
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

/**
 * A file the user may read but not change should fail here, in typed form, not at some later save.
 * A file that was read is only tested: writing it back now would rewrite bytes nothing has changed,
 * and the caller may still decide to leave it exactly as it is (a database from a newer schema).
 * A database this open creates, or replaces after a repair, gets its first copy written.
 */
function ensureFileIsWritable(adapter: SqlJsAdapter, dbPath: string, isFromFile: boolean): void {
  try {
    if (isFromFile) {
      accessSync(dbPath, constants.W_OK);
    } else {
      adapter.persist();
    }
  } catch (error) {
    adapter.close();
    throw toOpenError(error, dbPath);
  }
}

interface StoredDatabase {
  readonly db: SqlJsDatabase;
  /** The file's own contents were loaded, as opposed to a database made new by this open. */
  readonly isFromFile: boolean;
}

/** Reads the file into memory. SQLite only judges its contents on the first statement, so probe. */
function readStoredDatabase(SQL: SqlJsModule, dbPath: string): StoredDatabase {
  if (!existsSync(dbPath)) {
    return { db: new SQL.Database(), isFromFile: false };
  }
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    db.exec('SELECT 1 FROM sqlite_master LIMIT 1');
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, isFromFile: true };
}

/**
 * Loads the database. The file is copied under a backup name and emptied in place only when SQLite
 * itself reports it as corrupt; an unreadable file or any unrecognised failure leaves it exactly
 * as it is.
 */
function openStoredDatabase(SQL: SqlJsModule, dbPath: string): StoredDatabase {
  try {
    return readOrQuarantine(SQL, dbPath);
  } catch (error) {
    throw toOpenError(error, dbPath);
  }
}

function readOrQuarantine(SQL: SqlJsModule, dbPath: string): StoredDatabase {
  const failedFingerprint = fileFingerprint(dbPath);
  try {
    return readStoredDatabase(SQL, dbPath);
  } catch (error) {
    if (classifyOpenError(error) !== 'corrupt') throw error;
    // If another process replaced the file meanwhile, nothing is changed and the read below judges
    // whatever is there now.
    const backupPath = quarantineCorruptDatabase(dbPath, failedFingerprint, error);
    return backupPath === undefined
      ? readStoredDatabase(SQL, dbPath)
      : { db: new SQL.Database(), isFromFile: false };
  }
}
