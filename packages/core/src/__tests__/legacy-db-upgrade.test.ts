import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import {
  FAVORITE_ID,
  SAMPLE_ENTRY_COUNT,
  USED_ID,
  createLegacyDatabase,
  createMaintainerShapedDatabase,
  engineMeta,
  ftsMatches,
  ftsRowCount,
  recordedVersions,
  rowCounts,
  schemaObjects,
  withDatabase,
  CURRENT_VERSIONS,
} from './migration-fixtures.js';

// A vault.db created by the published @commandvault/core@0.1.0 (schema_version MAX = 2,
// external-content FTS5 table entries_fts with sync triggers) must open with the current engine.
// better-sqlite3 >= 12 enables SQLITE_DBCONFIG_DEFENSIVE, which forbids dropping FTS5 shadow tables
// directly, so the legacy cleanup has to drop the virtual table itself.
//
// The fixture (migration-fixtures.ts) copies its DDL from a database produced by the real 0.1.0
// package (better-sqlite3 11.10).

function execOnLegacyDatabase(path: string, statements: readonly string[]): void {
  withDatabase(path, (db) => {
    for (const statement of statements) db.exec(statement);
  });
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
    expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });

  it('replaces the legacy external-content FTS table and its triggers, and records every version', async () => {
    const engine = await SqliteEngine.create(dbPath);
    engine.close();

    const sqlByName = schemaObjects(dbPath);
    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
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
    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
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
    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });

  it('records the full-text table as ready, so it is not rebuilt again', async () => {
    (await SqliteEngine.create(dbPath)).close();

    expect(engineMeta(dbPath).fts_state).toBe('ready');
  });

  it('is idempotent: opening the upgraded database again changes nothing', async () => {
    (await SqliteEngine.create(dbPath)).close();
    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.getEntry(FAVORITE_ID)?.favorite).toBe(true);
    } finally {
      engine.close();
    }
    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
  });
});

// A database with the three 0.1.0 triggers but no table for them to write to: the triggers fire on
// every change to `entries`, migration 2 among them, and each of those changes would fail.
describe('upgrade from a schema-1 database whose 0.1.0 triggers outlived their full-text table', () => {
  const USER_TABLES = ['entries', 'user_tags', 'entry_tags', 'scan_snapshots'] as const;
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-dangling-triggers-'));
    dbPath = join(tempDir, 'vault.db');
    createMaintainerShapedDatabase(dbPath, { danglingTriggers: true });
    withDatabase(dbPath, (db) => db.exec('DELETE FROM schema_version WHERE version > 1'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts out with the triggers and without the table they write to', () => {
    const objects = schemaObjects(dbPath);

    for (const trigger of ['entries_ai', 'entries_ad', 'entries_au']) {
      expect(objects.has(trigger)).toBe(true);
    }
    expect(objects.has('entries_fts')).toBe(false);
    expect(recordedVersions(dbPath)).toEqual([1]);
  });

  it('removes the triggers before migration 2 rewrites the entries, and migrates completely', async () => {
    const countsBefore = rowCounts(dbPath, USER_TABLES);

    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.getEntry(FAVORITE_ID)?.favorite).toBe(true);
      expect(engine.toggleFavorite(USED_ID)).toBe(true);
    } finally {
      engine.close();
    }

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(rowCounts(dbPath, USER_TABLES)).toEqual(countsBefore);
    const objects = schemaObjects(dbPath);
    for (const trigger of ['entries_ai', 'entries_ad', 'entries_au']) {
      expect(objects.has(trigger)).toBe(false);
    }
    expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });
});
