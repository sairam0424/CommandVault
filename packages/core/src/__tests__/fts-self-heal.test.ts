import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  FAVORITE_ID,
  SAMPLE_ENTRY_COUNT,
  USED_ID,
  createMaintainerShapedDatabase,
  engineMeta,
  ftsMatches,
  ftsRowCount,
  insertSampleData,
  legacyTriggerDdl,
  recordedVersions,
  rowCounts,
  schemaObjects,
  tableChecksums,
  withDatabase,
  withReadonlyDatabase,
  CURRENT_VERSIONS,
} from './migration-fixtures.js';

// The maintainer's own vault.db is at schema 1-4 with no entries_fts and a plain table
// entries_fts_content left behind. Migrations are gated on the highest recorded version, so the
// full-text table never came back; the engine now checks it on every open.

const scenario = vi.hoisted(() => ({ hideFts5Module: false, writes: [] as string[] }));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter = await original.createDatabaseAdapter(...args);
      return instrumentAdapter(adapter, {
        // The one thing SQLite will not do for us: pretend the fts5 module is not compiled in.
        answerQuery: (sql) =>
          scenario.hideFts5Module && /pragma_module_list/i.test(sql) ? [] : undefined,
        // Every statement and transaction the engine sends. A write that changes nothing, such as
        // an upsert of the value already there, leaves `data_version` alone but is still a write
        // (on sql.js it would mark the whole file for saving), so it is counted here.
        beforeExecute: (sql) => scenario.writes.push(sql.replace(/\s+/g, ' ').trim()),
        onTransaction: (options) =>
          scenario.writes.push(`transaction ${options?.mode ?? 'deferred'}`),
      });
    },
  };
});

function dataVersionProbe(path: string): { read: () => number; close: () => void } {
  const probe = new Database(path);
  return {
    read: () => probe.pragma('data_version', { simple: true }) as number,
    close: () => probe.close(),
  };
}

describe('full-text search table self-heal', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fts-heal-'));
    dbPath = join(tempDir, 'vault.db');
  });

  afterEach(async () => {
    scenario.hideFts5Module = false;
    scenario.writes = [];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("a database shaped like the maintainer's (schema 1-4, orphan entries_fts_content)", () => {
    beforeEach(() => createMaintainerShapedDatabase(dbPath));

    it('recreates entries_fts over the existing entries and finds them by full-text match', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
      const sql = schemaObjects(dbPath).get('entries_fts') ?? '';
      expect(sql).toMatch(/VIRTUAL TABLE entries_fts USING fts5/i);
      expect(schemaObjects(dbPath).has('entries_fts_data')).toBe(true);
    });

    it('keeps every favorite, usage count, tag and snapshot exactly as it was', async () => {
      const checksumsBefore = tableChecksums(dbPath);
      const countsBefore = rowCounts(dbPath);

      const engine = await SqliteEngine.create(dbPath);
      try {
        expect(engine.getEntry(FAVORITE_ID)?.favorite).toBe(true);
        expect(engine.getEntry(USED_ID)?.usageCount).toBe(3);
        expect(engine.getTagsForEntry(FAVORITE_ID)).toContain('upgrade-test');
      } finally {
        engine.close();
      }

      expect(rowCounts(dbPath)).toEqual(countsBefore);
      expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
    });

    it('records that the full-text table is ready', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(engineMeta(dbPath).fts_state).toBe('ready');
    });

    it('does not touch the table again on the next open', async () => {
      (await SqliteEngine.create(dbPath)).close();
      // A row only the FTS table has: a rebuild from `entries` would drop it.
      withDatabase(dbPath, (db) =>
        db
          .prepare(
            `INSERT INTO entries_fts (id, name, description, content, tags)
             VALUES ('marker', 'marker', 'marker', 'untouchedword', '')`,
          )
          .run(),
      );
      const probe = dataVersionProbe(dbPath);
      const versionBefore = probe.read();

      (await SqliteEngine.create(dbPath)).close();

      expect(ftsMatches(dbPath, 'untouchedword')).toEqual(['marker']);
      expect(probe.read()).toBe(versionBefore);
      probe.close();
    });

    it('lets the search engine answer from the full-text table', async () => {
      (await SqliteEngine.create(dbPath)).close();
      // A word only the FTS table knows about: LIKE over `entries` cannot find it.
      withDatabase(dbPath, (db) =>
        db
          .prepare(
            `INSERT INTO entries_fts (id, name, description, content, tags)
             VALUES (?, 'demo-skill', '', 'ftsonlyword', '')`,
          )
          .run(USED_ID),
      );

      const engine = await SqliteEngine.create(dbPath);
      try {
        const names = engine.search({ query: 'ftsonlyword', limit: 10 }).map((r) => r.entry.name);
        expect(names).toEqual(['demo-skill']);
      } finally {
        engine.close();
      }
    });
  });

  describe('a maintainer-shaped database whose 0.1.0 triggers still exist', () => {
    beforeEach(() => createMaintainerShapedDatabase(dbPath, { danglingTriggers: true }));

    it('starts out unable to write to entries at all', () => {
      expect(() =>
        withDatabase(dbPath, (db) =>
          db.prepare('UPDATE entries SET usage_count = 9 WHERE id = ?').run(USED_ID),
        ),
      ).toThrow(/entries_fts/);
    });

    it('removes the triggers so that entries can be written again', async () => {
      const engine = await SqliteEngine.create(dbPath);
      try {
        engine.incrementUsage(USED_ID);
        expect(engine.getEntry(USED_ID)?.usageCount).toBe(4);
      } finally {
        engine.close();
      }

      const triggers = withReadonlyDatabase(dbPath, (db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(),
      );
      expect(triggers).toEqual([]);
      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
    });
  });

  describe('a database at the current schema whose full-text table was damaged afterwards', () => {
    beforeEach(async () => {
      (await SqliteEngine.create(dbPath)).close();
      withDatabase(dbPath, insertSampleData);
    });

    it('builds the table again from the entries when it has been dropped', async () => {
      withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));

      (await SqliteEngine.create(dbPath)).close();

      expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
    });

    it('drops every shadow table that outlived its virtual table', async () => {
      withDatabase(dbPath, (db) => {
        db.exec('DROP TABLE entries_fts');
        for (const suffix of ['data', 'idx', 'docsize', 'config', 'content']) {
          db.exec(`CREATE TABLE entries_fts_${suffix} (a, b)`);
        }
      });

      (await SqliteEngine.create(dbPath)).close();

      expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
      expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
    });

    it('removes 0.1.0 triggers that would make deleting an entry fail', async () => {
      withDatabase(dbPath, (db) => {
        for (const sql of legacyTriggerDdl()) db.exec(sql);
      });
      expect(() =>
        withDatabase(dbPath, (db) => db.prepare('DELETE FROM entries WHERE id = ?').run(USED_ID)),
      ).toThrow();

      const engine = await SqliteEngine.create(dbPath);
      try {
        engine.index([]);
        expect(engine.getEntry(USED_ID)).toBeUndefined();
      } finally {
        engine.close();
      }
    });

    it('leaves a healthy table alone, with rows the entries do not have', async () => {
      withDatabase(dbPath, (db) =>
        db
          .prepare(
            `INSERT INTO entries_fts (id, name, description, content, tags)
             VALUES ('marker', 'marker', 'marker', 'untouchedword', '')`,
          )
          .run(),
      );

      (await SqliteEngine.create(dbPath)).close();

      expect(ftsMatches(dbPath, 'untouchedword')).toEqual(['marker']);
    });
  });

  describe('when the FTS5 module is not available', () => {
    beforeEach(() => {
      createMaintainerShapedDatabase(dbPath);
      scenario.hideFts5Module = true;
    });

    it('opens without throwing and records that full-text search is unavailable', async () => {
      const engine = await SqliteEngine.create(dbPath);
      try {
        expect(engine.search({ query: 'deployment', limit: 10 }).map((r) => r.entry.name)).toEqual([
          'other-skill',
        ]);
      } finally {
        engine.close();
      }

      expect(engineMeta(dbPath).fts_state).toBe('unavailable');
      expect(schemaObjects(dbPath).has('entries_fts')).toBe(false);
    });

    it('leaves the plain tables it cannot judge alone and still migrates', async () => {
      const checksumsBefore = tableChecksums(dbPath);

      (await SqliteEngine.create(dbPath)).close();

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
      expect(
        withReadonlyDatabase(dbPath, (db) => db.pragma('integrity_check', { simple: true })),
      ).toBe('ok');
      // Not rebuilt: the plain table is still there with its rows (one per entry and a stale one),
      // and nothing of a virtual table has been made around it.
      const orphanRows = withReadonlyDatabase(
        dbPath,
        (db) =>
          (db.prepare('SELECT count(*) AS n FROM entries_fts_content').get() as { n: number }).n,
      );
      expect(orphanRows).toBe(SAMPLE_ENTRY_COUNT + 1);
      expect(schemaObjects(dbPath).has('entries_fts_data')).toBe(false);
    });

    it('does not write again when the state is already recorded', async () => {
      (await SqliteEngine.create(dbPath)).close();
      const probe = dataVersionProbe(dbPath);
      const versionBefore = probe.read();
      scenario.writes = [];

      (await SqliteEngine.create(dbPath)).close();

      expect(scenario.writes).toEqual([]);
      expect(probe.read()).toBe(versionBefore);
      probe.close();
    });
  });

  describe('a virtual table that lost one of its shadow tables', () => {
    beforeEach(async () => {
      (await SqliteEngine.create(dbPath)).close();
      withDatabase(dbPath, insertSampleData);
      // What a tool that drops shadow tables one by one leaves behind. better-sqlite3 refuses this
      // by default, so the test turns its protection off for its own connection only.
      withDatabase(dbPath, (db) => {
        db.unsafeMode(true);
        db.pragma('writable_schema = ON');
        db.exec("DELETE FROM sqlite_master WHERE name = 'entries_fts_config'");
        db.pragma('writable_schema = OFF');
      });
    });

    it('opens without throwing, keeps the user data and marks the full-text table unavailable', async () => {
      const checksumsBefore = tableChecksums(dbPath);

      const engine = await SqliteEngine.create(dbPath);
      try {
        expect(engine.search({ query: 'kubernetes', limit: 50 }).length).toBeGreaterThan(0);
      } finally {
        engine.close();
      }

      const meta = engineMeta(dbPath);
      expect(meta.fts_state).toBe('unavailable');
      expect(meta.fts_detail).toMatch(/entries_fts/);
      expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
    });
  });
});
