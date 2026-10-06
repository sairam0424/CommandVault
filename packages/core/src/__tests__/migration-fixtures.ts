import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import Database from 'better-sqlite3';
import { KNOWN_SCHEMA_VERSION } from '../indexer/migrations.js';

/**
 * Databases shaped like the ones real users have, built with the real driver and no mocks:
 * one written by the published @commandvault/core@0.1.0, and one shaped like the maintainer's own
 * vault.db (schema 1-4, no entries_fts, an orphaned plain table entries_fts_content).
 */

const ENTRIES_DDL = `CREATE TABLE entries (
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
  )`;

// The DDL below is copied from a database produced by the real 0.1.0 package (better-sqlite3 11.10).
const BASE_DDL = [
  ENTRIES_DDL,
  `CREATE TABLE user_tags (
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(entry_id, tag)
  )`,
  `CREATE TABLE scan_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL
  )`,
  `CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
  )`,
  'CREATE INDEX idx_entry_tags_tag ON entry_tags(tag)',
];

const LEGACY_FTS_DDL = [
  `CREATE VIRTUAL TABLE entries_fts USING fts5(
    name, description, tags, content,
    content='entries',
    content_rowid='rowid'
  )`,
  ...legacyTriggerDdl(),
];

/** The three triggers 0.1.0 used to keep its external-content FTS table in sync. */
export function legacyTriggerDdl(): string[] {
  return [
    `CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, name, description, tags, content)
    VALUES (new.rowid, new.name, new.description, new.tags, new.content);
  END`,
    `CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, name, description, tags, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.content);
  END`,
    `CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, name, description, tags, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.content);
    INSERT INTO entries_fts(rowid, name, description, tags, content)
    VALUES (new.rowid, new.name, new.description, new.tags, new.content);
  END`,
  ];
}

const VERSION_ROWS: ReadonlyArray<readonly [number, string]> = [
  [1, 'Add entry_tags junction table for exact tag matching'],
  [2, 'Migrate entry IDs from filePath-based to type+name-based'],
  [3, 'Add FTS5 full-text search table and column indexes'],
  [4, 'Add last_modified index for date range filters'],
];

const COLUMN_INDEX_DDL = [
  'CREATE INDEX idx_entries_type ON entries(type)',
  'CREATE INDEX idx_entries_source ON entries(source)',
  'CREATE INDEX idx_entries_favorite ON entries(favorite)',
  'CREATE INDEX idx_entries_last_modified ON entries(last_modified)',
];

/** What `entries_fts_content` looks like in the maintainer's database (five columns, no vtable). */
const ORPHAN_CONTENT_DDL =
  "CREATE TABLE 'entries_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4)";

/** Every version a fully migrated database has recorded: a new migration extends it by itself. */
export const CURRENT_VERSIONS: readonly number[] = Array.from(
  { length: KNOWN_SCHEMA_VERSION },
  (_, index) => index + 1,
);

export const FAVORITE_ID = '1f8080c615dc';
export const USED_ID = '7c1e988998f8';
export const SAMPLE_ENTRY_COUNT = 24;

/** Tables that hold the user's own data; everything the FTS is derived from or sits beside. */
export const USER_DATA_TABLES = ['entries', 'user_tags', 'entry_tags', 'scan_snapshots'] as const;

/** The full-text table as the released 0.1.7 migration 3 created it (IF NOT EXISTS, multi-line). */
const BASE_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          id UNINDEXED,
          name,
          description,
          content,
          tags
        )`;

/** A row only the full-text table has: a rebuild from `entries` would lose it. */
export const FTS_MARKER_WORD = 'untouchedword';

const CORRUPTION_BYTES = 64;
const CORRUPTION_FILL = 0xde;

interface SampleEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly tags: string;
  readonly content: string;
  readonly favorite: number;
  readonly usage: number;
}

export function withDatabase<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function withReadonlyDatabase<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function sampleEntries(): SampleEntry[] {
  const named: SampleEntry[] = [
    {
      id: FAVORITE_ID,
      name: 'other-skill',
      description: 'Another skill',
      filePath: '/home/u/.claude/skills/other-skill/SKILL.md',
      tags: 'misc',
      content: 'Deployment pipeline notes',
      favorite: 1,
      usage: 0,
    },
    {
      id: USED_ID,
      name: 'demo-skill',
      description: 'A demo skill for upgrade testing',
      filePath: '/home/u/.claude/skills/demo-skill/SKILL.md',
      tags: 'demo',
      content: 'Body of the demo skill',
      favorite: 0,
      usage: 3,
    },
  ];
  const filler = Array.from({ length: SAMPLE_ENTRY_COUNT - named.length }, (_, index) => ({
    id: `f0000000${String(index).padStart(4, '0')}`,
    name: `filler-${index}`,
    description: `Filler entry number ${index}`,
    filePath: `/home/u/.claude/skills/filler-${index}/SKILL.md`,
    tags: 'filler',
    content: `Filler body ${index} mentioning kubernetes${index % 3 === 0 ? ' and terraform' : ''}`,
    favorite: 0,
    usage: index % 5,
  }));
  return [...named, ...filler];
}

export function insertSampleData(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO entries (id, name, type, source, description, file_path, tags, metadata, content, last_modified, favorite, usage_count)
     VALUES (@id, @name, 'skill', 'custom', @description, @filePath, @tags, '{}', @content, '2026-05-02T00:00:00.000Z', @favorite, @usage)`,
  );
  for (const entry of sampleEntries()) insert.run(entry);
  db.prepare("INSERT INTO user_tags (entry_id, tag) VALUES (?, 'upgrade-test')").run(FAVORITE_ID);
  db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, 'misc')").run(FAVORITE_ID);
  db.prepare(
    "INSERT INTO scan_snapshots (id, name, type, content_hash) VALUES (?, ?, 'skill', 'h')",
  ).run(USED_ID, 'demo-skill');
}

function recordVersions(db: Database.Database, upTo: number): void {
  const insert = db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)');
  for (const [version, description] of VERSION_ROWS) {
    if (version <= upTo) insert.run(version, description);
  }
}

/**
 * Builds a database shaped exactly like one written by @commandvault/core@0.1.0 (schema 1-2), holding
 * the sample rows unless `populate` writes its own (legacy-vault-fixture.ts does).
 */
export function createLegacyDatabase(
  path: string,
  populate: (db: Database.Database) => void = insertSampleData,
): void {
  withDatabase(path, (db) => {
    for (const statement of [...BASE_DDL, ...LEGACY_FTS_DDL]) db.exec(statement);
    recordVersions(db, 2);
    populate(db);
  });
}

export interface MaintainerShapedOptions {
  /** Leave the three 0.1.0 triggers in place although the table they write to is gone. */
  readonly danglingTriggers?: boolean;
}

/**
 * Schema 1-4 and no `entries_fts`, with the plain table `entries_fts_content` left behind by a
 * full-text table whose other parts are gone. Migrations never run again on such a file, because
 * they are gated on the highest recorded version.
 */
export function createMaintainerShapedDatabase(
  path: string,
  options: MaintainerShapedOptions = {},
): void {
  withDatabase(path, (db) => {
    db.pragma('journal_mode = WAL');
    for (const statement of [...BASE_DDL, ...COLUMN_INDEX_DDL, ORPHAN_CONTENT_DDL]) {
      db.exec(statement);
    }
    recordVersions(db, 4);
    insertSampleData(db);
    const orphan = db.prepare(
      'INSERT INTO entries_fts_content (c0, c1, c2, c3, c4) VALUES (?, ?, ?, ?, ?)',
    );
    for (const entry of sampleEntries()) {
      orphan.run(entry.id, entry.name, entry.description, entry.content, entry.tags);
    }
    orphan.run('deleted-long-ago', 'ghost', 'stale duplicate', 'ghostword', '');
    if (options.danglingTriggers) for (const sql of legacyTriggerDdl()) db.exec(sql);
  });
}

/** sha256 over the rows of each table, in a fixed order: proves user data survived untouched. */
export function tableChecksums(
  path: string,
  tables: readonly string[] = USER_DATA_TABLES,
): Record<string, string> {
  return withReadonlyDatabase(path, (db) =>
    Object.fromEntries(
      tables.map((table) => {
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
        return [table, createHash('sha256').update(JSON.stringify(rows)).digest('hex')];
      }),
    ),
  );
}

export function rowCounts(
  path: string,
  tables: readonly string[] = USER_DATA_TABLES,
): Record<string, number> {
  return withReadonlyDatabase(path, (db) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    ),
  );
}

export function recordedVersions(path: string): number[] {
  return withReadonlyDatabase(path, (db) =>
    (
      db.prepare('SELECT version FROM schema_version ORDER BY version').all() as {
        version: number;
      }[]
    ).map((row) => row.version),
  );
}

/** Name -> stored SQL for every schema object except SQLite's own. */
export function schemaObjects(path: string): Map<string, string> {
  return withReadonlyDatabase(path, (db) => {
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string | null }[];
    return new Map(rows.map((row) => [row.name, row.sql ?? '']));
  });
}

/** Ids matched by the FTS table itself; the engine's own search falls back to LIKE silently. */
export function ftsMatches(path: string, term: string): string[] {
  return withReadonlyDatabase(path, (db) =>
    (
      db.prepare('SELECT id FROM entries_fts WHERE entries_fts MATCH ? ORDER BY id').all(term) as {
        id: string;
      }[]
    ).map((row) => row.id),
  );
}

export function ftsRowCount(path: string): number {
  return withReadonlyDatabase(
    path,
    (db) => (db.prepare('SELECT count(*) AS n FROM entries_fts').get() as { n: number }).n,
  );
}

export function engineMeta(path: string): Record<string, string> {
  return withReadonlyDatabase(path, (db) =>
    Object.fromEntries(
      (
        db.prepare('SELECT key, value FROM engine_meta').all() as { key: string; value: string }[]
      ).map((row) => [row.key, row.value]),
    ),
  );
}

/** Adds a row that only the full-text table has, to see whether a later open rebuilds the table. */
export function addFtsMarkerRow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO entries_fts (id, name, description, content, tags)
     VALUES ('marker', 'marker', 'marker', ?, '')`,
  ).run(FTS_MARKER_WORD);
}

/**
 * Schema 1-4 with the full-text table a released 0.1.7 built in migration 3: standalone, healthy,
 * holding a marker row that `entries` does not. Migrations 1-4 are recorded, 5 is not.
 */
export function createBaseHealthyDatabase(path: string): void {
  createMaintainerShapedDatabase(path);
  withDatabase(path, (db) => {
    db.exec('DROP TABLE entries_fts_content');
    db.exec(BASE_FTS_DDL);
    db.exec(`
      INSERT INTO entries_fts (id, name, description, content, tags)
      SELECT id, name, description, content, tags FROM entries
    `);
    addFtsMarkerRow(db);
  });
}

/**
 * Overwrites the start of the first leaf page of a table or index in the file itself, the way a bad
 * sector would: SQLite reports SQLITE_CORRUPT as soon as it reads that page. The database must not
 * be open.
 */
export function corruptTablePage(path: string, table: string): void {
  const { pageNumber, pageSize } = withReadonlyDatabase(path, (db) => ({
    pageNumber: (
      db
        .prepare("SELECT min(pageno) AS page FROM dbstat WHERE name = ? AND pagetype = 'leaf'")
        .get(table) as { page: number | null }
    ).page,
    pageSize: db.pragma('page_size', { simple: true }) as number,
  }));
  if (pageNumber === null) throw new Error(`${table} has no leaf page to damage`);
  const file = openSync(path, 'r+');
  try {
    const garbage = Buffer.alloc(CORRUPTION_BYTES, CORRUPTION_FILL);
    writeSync(file, garbage, 0, garbage.length, (pageNumber - 1) * pageSize);
  } finally {
    closeSync(file);
  }
}
