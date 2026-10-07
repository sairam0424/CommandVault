import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultEntry } from '../types/index.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import { engineMeta, withDatabase } from './migration-fixtures.js';
import { CORPUS, names, sortedNames } from './search-corpus.js';

const SCAN_ENTRIES = ['security-scan', 'security-scan-report'];
/** What an open without the fts5 module records (sqlite-engine.ts ensureFts). */
const RECORDED_BY_FTS_LESS_OPEN = {
  fts_state: 'unavailable',
  fts_detail: 'the SQLite build has no fts5 module',
};
/**
 * How SQLite words a full-text query against a table that cannot be used, observed in order on: a
 * plain table created under the name, the shadow table entries_fts_config dropped, and the shadow
 * table entries_fts_content dropped, which SQLite names with its schema (better-sqlite3 refuses to
 * drop a shadow table unless the connection is made unsafe; the sqlite3 shell never refuses).
 */
const UNUSABLE_TABLE_MESSAGES = [
  'no such column: entries_fts',
  'vtable constructor failed: entries_fts',
  'no such table: main.entries_fts_content',
];

// An engine that opened with a healthy full-text table can lose it while it is open: another
// process (or a repair) dropped it, or one without fts5 recorded it unavailable and wrote the
// entries past it. The query that meets that answers with LIKE instead of failing or answering
// from stale rows, and the engine records the table unavailable, so that its own writes stop going
// to a table that is not there, until the next open rebuilds it. A failure that says nothing about
// the table (a lock, an I/O error, a query fts5 cannot parse) is not taken for a lost table: it
// reaches the caller as it would from any query.

const scenario = vi.hoisted(() => ({
  failFullTextQueryWith: undefined as Error | undefined,
  failStateRecordWith: undefined as Error | undefined,
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) =>
      instrumentAdapter(await original.createDatabaseAdapter(...args), {
        beforeQuery: (sql) => {
          if (scenario.failFullTextQueryWith !== undefined && /\bMATCH\b/.test(sql)) {
            throw scenario.failFullTextQueryWith;
          }
        },
        // The write that records the table's state (writeEngineMeta); what an open seeds is an
        // `INSERT OR IGNORE`.
        beforeExecute: (sql) => {
          if (scenario.failStateRecordWith !== undefined && /INSERT INTO engine_meta/.test(sql)) {
            throw scenario.failStateRecordWith;
          }
        },
      }),
  };
});

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The corpus with one entry changed: what a scan after the loss has to write. */
function changedCorpus(): VaultEntry[] {
  return CORPUS.map((entry) =>
    entry.id === 'browse' ? { ...entry, content: `${entry.content} freshword` } : entry,
  );
}

describe('a full-text table lost while the engine is open', () => {
  let tempDir: string;
  let dbPath: string;
  let engine: SqliteEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-search-fts-fallback-'));
    dbPath = join(tempDir, 'vault.db');
    engine = await SqliteEngine.create(dbPath);
    engine.index(CORPUS);
  });

  afterEach(async () => {
    scenario.failFullTextQueryWith = undefined;
    scenario.failStateRecordWith = undefined;
    engine.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('is answered with LIKE, recorded unavailable, and left out of the writes that follow', () => {
    expect(engine.supportsFullTextSearch).toBe(true);
    expect(engineMeta(dbPath).fts_state).toBe('ready');

    withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));

    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
    expect(engine.supportsFullTextSearch).toBe(false);
    const meta = engineMeta(dbPath);
    expect(meta.fts_state).toBe('unavailable');
    expect(meta.fts_detail).toContain('entries_fts');

    // The write path reads the recorded state: a changed entry is written past the missing table.
    expect(() => engine.index(changedCorpus())).not.toThrow();
    expect(names(engine.search({ query: 'freshword', limit: 5 }))).toEqual(['browse']);
  });

  it('is rebuilt by the next open, which searches with fts5 again', async () => {
    withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));
    engine.search({ query: 'security-scan', limit: 5 });
    engine.close();

    engine = await SqliteEngine.create(dbPath);

    expect(engine.supportsFullTextSearch).toBe(true);
    expect(engineMeta(dbPath).fts_state).toBe('ready');
    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
  });

  it('stays whole when recording it meets a lock: that failure reaches the caller, the next query records', () => {
    withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));
    scenario.failStateRecordWith = sqliteError('SQLITE_BUSY', 'database is locked');

    expect(() => engine.search({ query: 'security-scan', limit: 5 })).toThrow('database is locked');
    // Neither side moved: what the engine reads is still what the record says, as index() reads it.
    expect(engine.supportsFullTextSearch).toBe(true);
    expect(engineMeta(dbPath).fts_state).toBe('ready');

    scenario.failStateRecordWith = undefined;
    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
    expect(engine.supportsFullTextSearch).toBe(false);
    expect(engineMeta(dbPath).fts_state).toBe('unavailable');
    expect(() => engine.index(changedCorpus())).not.toThrow();
    expect(names(engine.search({ query: 'freshword', limit: 5 }))).toEqual(['browse']);
  });

  it('is not what a lock is taken for: that failure reaches the caller and changes nothing', () => {
    scenario.failFullTextQueryWith = sqliteError('SQLITE_BUSY', 'database is locked');

    expect(() => engine.search({ query: 'security-scan', limit: 5 })).toThrow('database is locked');
    expect(engine.supportsFullTextSearch).toBe(true);
    expect(engineMeta(dbPath).fts_state).toBe('ready');

    scenario.failFullTextQueryWith = undefined;
    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
  });

  it('is not what an I/O failure is taken for either', () => {
    scenario.failFullTextQueryWith = sqliteError('SQLITE_IOERR_READ', 'disk I/O error');

    expect(() => engine.search({ query: 'browse', limit: 5 })).toThrow('disk I/O error');
    expect(engine.supportsFullTextSearch).toBe(true);
    expect(engineMeta(dbPath).fts_state).toBe('ready');
  });

  it('is not what a query fts5 cannot parse is taken for: the table is healthy, the query is not', () => {
    scenario.failFullTextQueryWith = sqliteError('SQLITE_ERROR', 'fts5: syntax error near "x"');

    expect(() => engine.search({ query: 'browse', limit: 5 })).toThrow('fts5: syntax error');
    expect(engine.supportsFullTextSearch).toBe(true);
    expect(engineMeta(dbPath).fts_state).toBe('ready');
  });

  it.each(UNUSABLE_TABLE_MESSAGES)('is what SQLite means by %j', (message) => {
    scenario.failFullTextQueryWith = sqliteError('SQLITE_ERROR', message);

    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
    expect(engine.supportsFullTextSearch).toBe(false);
    expect(engineMeta(dbPath)).toMatchObject({ fts_state: 'unavailable' });
    expect(engineMeta(dbPath).fts_detail).toContain(message);
  });

  it('is what a shadow table dropped from under it is, on a real database', () => {
    // SQLite in its defensive mode, which better-sqlite3 turns on, refuses to drop a shadow table;
    // the sqlite3 shell does not, and neither does a connection asked to be unsafe.
    withDatabase(dbPath, (db) => {
      db.unsafeMode(true);
      db.exec('DROP TABLE entries_fts_content');
    });

    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
    expect(engine.supportsFullTextSearch).toBe(false);
    expect(engineMeta(dbPath).fts_detail).toContain('entries_fts_content');
    expect(() => engine.index(changedCorpus())).not.toThrow();
    expect(names(engine.search({ query: 'freshword', limit: 5 }))).toEqual(['browse']);
  });

  it('is what corruption fts5 reports is, while the entries themselves read fine', () => {
    // What a shadow table of rows dropped from under the table produces (entries_fts_data, _idx).
    scenario.failFullTextQueryWith = sqliteError(
      'SQLITE_CORRUPT_VTAB',
      'fts5: corruption found reading blob 10 from table "entries_fts"',
    );

    expect(sortedNames(engine.search({ query: 'security-scan', limit: 5 }))).toEqual(SCAN_ENTRIES);
    expect(engine.supportsFullTextSearch).toBe(false);
    expect(engineMeta(dbPath).fts_detail).toContain('corruption found');
  });

  it('is left out of the reads too once another process records it unavailable', () => {
    withDatabase(dbPath, (db) => {
      const record = db.prepare('UPDATE engine_meta SET value = $value WHERE key = $key');
      for (const [key, value] of Object.entries(RECORDED_BY_FTS_LESS_OPEN))
        record.run({ key, value });
    });

    // The write path reads the record (S1): the changed entry is written past the table ...
    engine.index(changedCorpus());
    const ftsRows = withDatabase(dbPath, (db) =>
      db.prepare("SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'freshword'").get(),
    ) as { n: number };
    expect(ftsRows.n).toBe(0);

    // ... so a read from the table would miss it. The read path reads the same record.
    expect(names(engine.search({ query: 'freshword', limit: 5 }))).toEqual(['browse']);
    expect(engine.supportsFullTextSearch).toBe(false);
    // The record is the other process's: nothing of it is rewritten.
    expect(engineMeta(dbPath)).toMatchObject(RECORDED_BY_FTS_LESS_OPEN);
  });
});
