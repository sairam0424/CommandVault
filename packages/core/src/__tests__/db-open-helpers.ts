import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi, type MockInstance } from 'vitest';
import Database from 'better-sqlite3';
import { fileFingerprint } from '../indexer/quarantine-fs.js';

export const GARBAGE_BYTES = 4096;
export const PAGE_SIZE = 4096;

/**
 * Filename -> sha256 for every file in `dir` (or those `isWanted` picks), so a test can prove
 * nothing moved or changed.
 */
export function snapshotDir(
  dir: string,
  isWanted: (name: string) => boolean = () => true,
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of readdirSync(dir).sort().filter(isWanted)) {
    snapshot[name] = createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex');
  }
  return snapshot;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cv-${prefix}-`));
}

export function writeGarbage(path: string): Buffer {
  const bytes = randomBytes(GARBAGE_BYTES);
  writeFileSync(path, bytes);
  return bytes;
}

export interface SeedOptions {
  readonly wal?: boolean;
  readonly rows?: number;
}

const ROW_PAYLOAD = 'x'.repeat(200);

/** Creates a real SQLite database holding favorite-like rows the tests can look for afterwards. */
export function seedDatabase(path: string, options: SeedOptions = {}): void {
  const db = new Database(path);
  try {
    db.pragma(`journal_mode = ${options.wal ? 'WAL' : 'DELETE'}`);
    db.exec('CREATE TABLE favorites (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO favorites (label) VALUES (?)');
    // One transaction: thousands of separately committed inserts take seconds and risk the timeout.
    db.transaction(() => {
      for (let row = 0; row < (options.rows ?? 3); row += 1) {
        insert.run(`${ROW_PAYLOAD}${row}`);
      }
    })();
  } finally {
    db.close();
  }
}

/**
 * Creates a WAL-mode database whose rows are only in the -wal file: the schema is in the main file
 * and the inserts were never checkpointed. Copying the three files while the writer is still open
 * is what a crash leaves behind.
 */
export function seedUncheckpointedDatabase(path: string, rows: number): void {
  const scratch = `${path}.seed`;
  mkdirSync(scratch);
  const seedPath = join(scratch, 'vault.db');
  const db = new Database(seedPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE favorites (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const insert = db.prepare('INSERT INTO favorites (label) VALUES (?)');
    for (let row = 0; row < rows; row += 1) insert.run(`${ROW_PAYLOAD}${row}`);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(seedPath + suffix)) copyFileSync(seedPath + suffix, path + suffix);
    }
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Adds a schema entry this SQLite cannot parse to a healthy database, which is what a file written
 * by a newer SQLite looks like to an older one. SQLite reports it as SQLITE_CORRUPT with a
 * "malformed database schema (<name>) - <detail>" message, although nothing in the file is damaged.
 */
export function addUnparseableSchemaEntry(path: string, createSql: string): void {
  const db = new Database(path);
  try {
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'k2', 'k2', 2, ?)",
    ).run(createSql);
    db.pragma('writable_schema = OFF');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export function countFavorites(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS c FROM favorites').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

export interface StderrCapture {
  readonly spy: MockInstance;
  /** Every string written to stderr while the capture was active. */
  lines(): string[];
}

export function captureStderr(): StderrCapture {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    spy,
    lines: () => spy.mock.calls.map(([chunk]) => String(chunk)),
  };
}

export function backupNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => /\.corrupt\.\d+(-\d+)?\.bak/.test(name));
}

/**
 * How long a repair that is expected to take an abandoned lock over may wait for it. Far below the
 * ten seconds an unnamed lock needs to age, so a takeover that waited for age would give up, yet
 * long enough that a machine stalled for a moment is not taken for a timeout.
 */
export const PATIENT_WAIT_MS = 5_000;

/** A failure as a file system call reports it, for tests that make one step of a repair fail. */
export function fsError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${code}: simulated failure, ${syscall}`), { code });
}

/** The id of a process that has already exited, so nothing holds it any more. */
export function deadProcessId(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/** What `run` throws, or undefined when it returns. */
export function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A corrupt database with all three sidecars; the fingerprint a failed open would have taken. */
export function writeCorruptSet(dbPath: string): string | undefined {
  writeFileSync(dbPath, 'corrupt');
  writeFileSync(`${dbPath}-wal`, 'wal');
  writeFileSync(`${dbPath}-shm`, 'shm');
  writeFileSync(`${dbPath}-journal`, 'journal');
  return fileFingerprint(dbPath);
}
