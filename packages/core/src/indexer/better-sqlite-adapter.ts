import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import type { DatabaseAdapter, DatabaseAdapterOptions } from './database-adapter.js';
import { classifyOpenError, toOpenError } from './db-errors.js';
import { fileFingerprint, quarantineCorruptDatabase } from './quarantine.js';
import { OWNER_ONLY_MODE } from './quarantine-fs.js';
import { withRegisteredOpener } from './quarantine-openers.js';

const DEFAULT_BUSY_TIMEOUT = 5000;
const OPEN_LOCK_RETRIES = 3;
// A corrupt file is judged again when the file changed under the attempt that failed; see below.
const MAX_OPEN_ATTEMPTS = 3;
const OPEN_LOCK_RETRY_DELAY_MS = 100;

interface OpenSettings {
  readonly walMode: boolean;
  readonly busyTimeout: number;
  readonly readonly: boolean;
}

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
    return new BetterSqliteAdapter(await openDatabase(dbPath, options), dbPath);
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

async function openDatabase(
  dbPath: string,
  options?: DatabaseAdapterOptions,
): Promise<Database.Database> {
  const settings: OpenSettings = {
    walMode: options?.walMode ?? true,
    busyTimeout: options?.busyTimeout ?? DEFAULT_BUSY_TIMEOUT,
    readonly: options?.readonly ?? false,
  };

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    return await openOrQuarantine(dbPath, settings);
  } catch (error) {
    throw toOpenError(error, dbPath);
  }
}

/**
 * Opens the database. The file is repaired only when SQLite itself reports it as corrupt
 * (SQLITE_NOTADB / SQLITE_CORRUPT): its contents are copied under a backup name and the file is
 * emptied in place, see quarantineCorruptDatabase. Every other failure (missing native addon, lock,
 * permissions, disk) leaves it exactly as it is, because none of them says anything about its
 * contents.
 *
 * The file is identified before each attempt and the repair only happens if it is still that file.
 * When it is not, someone changed it meanwhile and the next attempt judges whatever is there now.
 * That someone can be SQLite itself: closing a failed handle folds a write-ahead log into the
 * file and deletes the -wal and -shm, and only the attempt after that sees the settled file.
 */
async function openOrQuarantine(
  dbPath: string,
  settings: OpenSettings,
): Promise<Database.Database> {
  for (let attempt = 1; ; attempt += 1) {
    const failedFingerprint = fileFingerprint(dbPath);
    try {
      return await openWithLockRetry(dbPath, settings);
    } catch (error) {
      const isLastAttempt = attempt >= MAX_OPEN_ATTEMPTS;
      if (classifyOpenError(error) !== 'corrupt' || settings.readonly || isLastAttempt) throw error;
      // The failed handle is closed by now, which the repair requires.
      quarantineCorruptDatabase(dbPath, failedFingerprint, error);
    }
  }
}

async function openWithLockRetry(
  dbPath: string,
  settings: OpenSettings,
): Promise<Database.Database> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return openRegistered(dbPath, settings);
    } catch (error) {
      if (classifyOpenError(error) !== 'locked' || attempt >= OPEN_LOCK_RETRIES) throw error;
      await delay(OPEN_LOCK_RETRY_DELAY_MS);
    }
  }
}

/**
 * The open is registered, so a repair of the same file waits for it instead of emptying the file
 * under it (see quarantine-openers.ts). A read-only open is not: it never repairs anything, and
 * must work where the folder cannot be written to.
 */
function openRegistered(dbPath: string, settings: OpenSettings): Database.Database {
  if (settings.readonly) return openOnce(dbPath, settings);
  return withRegisteredOpener(dbPath, () => openOnce(dbPath, settings));
}

function openOnce(dbPath: string, settings: OpenSettings): Database.Database {
  const existed = existsSync(dbPath);
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: settings.readonly && existed });
    configureDatabase(db, settings.walMode, settings.busyTimeout);
    assertReadable(db);
    if (!existed) {
      chmodSync(dbPath, OWNER_ONLY_MODE);
    }
    return db;
  } catch (error) {
    closeAfterFailedOpen(db);
    throw error;
  }
}

function closeAfterFailedOpen(db: Database.Database | undefined): void {
  try {
    db?.close();
  } catch {
    // The open error being rethrown is the actionable one; the handle may already be unusable.
  }
}

function configureDatabase(
  db: Database.Database,
  walMode: boolean,
  busyTimeout: number,
): Database.Database {
  // Before the WAL switch: that switch needs a lock, and must wait for one rather than fail.
  db.pragma(`busy_timeout = ${busyTimeout}`);
  if (walMode) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  return db;
}

/** better-sqlite3 opens lazily: reading the schema is what makes SQLite judge the file. */
function assertReadable(db: Database.Database): void {
  db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
}
