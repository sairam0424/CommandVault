import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteEngine } from '../indexer/sqlite-engine.js';

// A vault.db created by the published @commandvault/core@0.1.0 (schema_version MAX = 2,
// external-content FTS5 table entries_fts with sync triggers) must open with the current engine.
// better-sqlite3 >= 12 enables SQLITE_DBCONFIG_DEFENSIVE, which forbids dropping FTS5 shadow tables
// directly, so the legacy cleanup has to drop the virtual table itself.
//
// The DDL below is copied from a database produced by the real 0.1.0 package (better-sqlite3 11.10).

const LEGACY_DDL = [
  `CREATE TABLE entries (
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
  )`,
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
  `CREATE VIRTUAL TABLE entries_fts USING fts5(
    name, description, tags, content,
    content='entries',
    content_rowid='rowid'
  )`,
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

const FAVORITE_ID = '1f8080c615dc';
const USED_ID = '7c1e988998f8';

/** Builds a database shaped exactly like one written by @commandvault/core@0.1.0. */
function createLegacyDatabase(path: string): void {
  const db = new Database(path);
  try {
    for (const statement of LEGACY_DDL) db.exec(statement);
    db.exec(`
      INSERT INTO schema_version (version, description) VALUES
        (1, 'Add entry_tags junction table for exact tag matching'),
        (2, 'Migrate entry IDs from filePath-based to type+name-based');
    `);
    const insert = db.prepare(
      `INSERT INTO entries (id, name, type, source, description, file_path, tags, metadata, content, last_modified, favorite, usage_count)
       VALUES (@id, @name, 'skill', 'custom', @description, @file_path, @tags, '{}', @content, '2026-05-02T00:00:00.000Z', @favorite, @usage)`,
    );
    insert.run({
      id: FAVORITE_ID,
      name: 'other-skill',
      description: 'Another skill',
      file_path: '/home/u/.claude/skills/other-skill/SKILL.md',
      tags: 'misc',
      content: 'Deployment pipeline notes',
      favorite: 1,
      usage: 0,
    });
    insert.run({
      id: USED_ID,
      name: 'demo-skill',
      description: 'A demo skill for upgrade testing',
      file_path: '/home/u/.claude/skills/demo-skill/SKILL.md',
      tags: 'demo',
      content: 'Body of the demo skill',
      favorite: 0,
      usage: 3,
    });
    db.prepare("INSERT INTO user_tags (entry_id, tag) VALUES (?, 'upgrade-test')").run(FAVORITE_ID);
    db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, 'misc')").run(FAVORITE_ID);
  } finally {
    db.close();
  }
}

function readSchema(path: string): { sqlByName: Map<string, string>; versions: number[] } {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string | null }[];
    const versions = (
      db.prepare('SELECT version FROM schema_version ORDER BY version').all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    return { sqlByName: new Map(rows.map((r) => [r.name, r.sql ?? ''])), versions };
  } finally {
    db.close();
  }
}

/** Ids matched by the FTS table itself; the engine's own search silently falls back to LIKE. */
function ftsMatches(path: string, term: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.prepare('SELECT id FROM entries_fts WHERE entries_fts MATCH ?').all(term) as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  } finally {
    db.close();
  }
}

function ftsRowCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM entries_fts').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function execOnLegacyDatabase(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

describe('upgrade from a database written by @commandvault/core 0.1.0', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-legacy-upgrade-'));
    dbPath = join(tempDir, 'vault.db');
    createLegacyDatabase(dbPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('opens the legacy database without throwing', async () => {
    const engine = await SqliteEngine.create(dbPath);
    engine.close();
  });

  it('keeps favorites, usage counts and user tags', async () => {
    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.getEntry(FAVORITE_ID)?.favorite).toBe(true);
      expect(engine.getEntry(USED_ID)?.usageCount).toBe(3);
      expect(engine.getTagsForEntry(FAVORITE_ID)).toContain('upgrade-test');
    } finally {
      engine.close();
    }
  });

  it('rebuilds full-text search over the existing entries', async () => {
    const engine = await SqliteEngine.create(dbPath);
    try {
      const names = engine.search({ query: 'deployment', limit: 10 }).map((r) => r.entry.name);
      expect(names).toEqual(['other-skill']);
    } finally {
      engine.close();
    }
    expect(ftsRowCount(dbPath)).toBe(2);
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });

  it('replaces the legacy external-content FTS table and its triggers, and records v3 and v4', async () => {
    const engine = await SqliteEngine.create(dbPath);
    engine.close();

    const { sqlByName, versions } = readSchema(dbPath);
    expect(versions).toEqual([1, 2, 3, 4]);
    expect(sqlByName.get('entries_fts')).toBeDefined();
    expect(sqlByName.get('entries_fts')).not.toContain("content='entries'");
    for (const trigger of ['entries_ai', 'entries_ad', 'entries_au']) {
      expect(sqlByName.has(trigger)).toBe(false);
    }
  });

  it('recovers a database the broken build left half-cleaned (triggers gone, legacy FTS intact)', async () => {
    execOnLegacyDatabase(dbPath, [
      'DROP TRIGGER entries_ai',
      'DROP TRIGGER entries_ad',
      'DROP TRIGGER entries_au',
    ]);
    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.getEntry(FAVORITE_ID)?.favorite).toBe(true);
    } finally {
      engine.close();
    }
    expect(readSchema(dbPath).versions).toEqual([1, 2, 3, 4]);
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });

  it('upgrades a version-2 database whose legacy FTS was already removed by an older release', async () => {
    execOnLegacyDatabase(dbPath, [
      'DROP TRIGGER entries_ai',
      'DROP TRIGGER entries_ad',
      'DROP TRIGGER entries_au',
      'DROP TABLE entries_fts',
    ]);
    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.getEntry(USED_ID)?.usageCount).toBe(3);
    } finally {
      engine.close();
    }
    expect(readSchema(dbPath).versions).toEqual([1, 2, 3, 4]);
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });

  it('is idempotent: opening the upgraded database again changes nothing', async () => {
    (await SqliteEngine.create(dbPath)).close();
    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.getEntry(FAVORITE_ID)?.favorite).toBe(true);
    } finally {
      engine.close();
    }
    expect(readSchema(dbPath).versions).toEqual([1, 2, 3, 4]);
  });
});
