import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseCorruptError, DatabaseLockedError } from '../indexer/db-errors.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  CURRENT_VERSIONS,
  FAVORITE_ID,
  FTS_MARKER_WORD,
  SAMPLE_ENTRY_COUNT,
  USED_ID,
  addFtsMarkerRow,
  corruptTablePage,
  createBaseHealthyDatabase,
  createMaintainerShapedDatabase,
  engineMeta,
  ftsMatches,
  ftsRowCount,
  insertSampleData,
  recordedVersions,
  schemaObjects,
  tableChecksums,
  withDatabase,
} from './migration-fixtures.js';

// What makes the engine judge the full-text table damaged, and what it does not take for damage.
// Every check in the health test has a case here that only that check can catch.

// The engine's own statements, as SQLite sees them: the look at the table and its neighbours, the
// row count that proves it can be read, and the statement that fills a rebuilt table.
const FTS_OBJECTS_QUERY = /substr\(name, 1, \$prefixLength\)/;
const FTS_COUNT_QUERY = /count\(\*\) AS n FROM entries_fts/;
const FTS_POPULATE_STATEMENT = /INSERT INTO entries_fts/;

const scenario = vi.hoisted(() => ({
  firstLookFindsNoTable: false,
  lockedWhileCounting: false,
  moduleReportsCorruption: false,
}));

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) =>
      instrumentAdapter(await original.createDatabaseAdapter(...args), {
        // The first look at the table happens before the write lock is taken; what another process
        // did in the meantime is simulated by answering that look as if the table were gone.
        answerQuery: (sql) => {
          if (!scenario.firstLookFindsNoTable || !FTS_OBJECTS_QUERY.test(sql)) return undefined;
          scenario.firstLookFindsNoTable = false;
          return [];
        },
        beforeQuery: (sql) => {
          if (scenario.lockedWhileCounting && FTS_COUNT_QUERY.test(sql)) {
            throw sqliteError('SQLITE_BUSY', 'database is locked');
          }
        },
        beforeExecute: (sql) => {
          if (scenario.moduleReportsCorruption && FTS_POPULATE_STATEMENT.test(sql)) {
            throw sqliteError('SQLITE_CORRUPT_VTAB', 'database disk image is malformed');
          }
        },
      }),
  };
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function failureOf(path: string): Promise<unknown> {
  return SqliteEngine.create(path).then(
    (engine) => {
      engine.close();
      return undefined;
    },
    (error: unknown) => error,
  );
}

/** What is beside the database, without the write-ahead log files that come and go with a handle. */
function filesBeside(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
    .sort();
}

/** Deletes a shadow table's schema entry, leaving the virtual table itself in place. */
function forgetShadowTable(path: string, shadow: string): void {
  withDatabase(path, (db) => {
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare('DELETE FROM sqlite_master WHERE name = ?').run(shadow);
    db.pragma('writable_schema = OFF');
  });
}

describe('the health check of the full-text table', () => {
  let tempDir: string;
  let dbPath: string;

  /** A database at the current schema whose full-text table is healthy and holds a marker row. */
  async function createHealthyDatabase(): Promise<void> {
    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) => {
      insertSampleData(db);
      addFtsMarkerRow(db);
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fts-health-'));
    dbPath = join(tempDir, 'vault.db');
  });

  afterEach(async () => {
    scenario.firstLookFindsNoTable = false;
    scenario.lockedWhileCounting = false;
    scenario.moduleReportsCorruption = false;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('for a database a released 0.1.7 built (schema 1-4, standalone full-text table)', () => {
    beforeEach(() => createBaseHealthyDatabase(dbPath));

    it('finds the table healthy, records it as ready and does not rebuild it', async () => {
      expect(recordedVersions(dbPath)).toEqual([1, 2, 3, 4]);

      (await SqliteEngine.create(dbPath)).close();

      expect(engineMeta(dbPath).fts_state).toBe('ready');
      expect(ftsMatches(dbPath, FTS_MARKER_WORD)).toEqual(['marker']);
    });

    it('takes a safety copy before migrating it', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(readdirSync(join(tempDir, 'backups'))).toHaveLength(1);
    });
  });

  describe('when another process repairs the table while this one waits for the write lock', () => {
    beforeEach(createHealthyDatabase);

    it('looks again under the lock and does not rebuild a table that is healthy by then', async () => {
      scenario.firstLookFindsNoTable = true;

      (await SqliteEngine.create(dbPath)).close();

      // A rebuild fills the table from `entries` alone and would lose the marker.
      expect(ftsMatches(dbPath, FTS_MARKER_WORD)).toEqual(['marker']);
      expect(engineMeta(dbPath).fts_state).toBe('ready');
    });
  });

  describe('when another process holds a lock while the table is read', () => {
    beforeEach(createHealthyDatabase);

    it('reports the lock and leaves the table alone, instead of taking it for damage', async () => {
      scenario.lockedWhileCounting = true;

      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      scenario.lockedWhileCounting = false;
      expect(ftsMatches(dbPath, FTS_MARKER_WORD)).toEqual(['marker']);
    });
  });

  describe('a virtual table with other columns than the ones this build searches', () => {
    beforeEach(async () => {
      await createHealthyDatabase();
      withDatabase(dbPath, (db) => {
        db.exec('DROP TABLE entries_fts');
        db.exec('CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, name, description)');
        db.exec(
          `INSERT INTO entries_fts (id, name, description)
           VALUES ('marker', 'marker', '${FTS_MARKER_WORD}')`,
        );
      });
    });

    it('is replaced by one with the definition this build searches', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(schemaObjects(dbPath).get('entries_fts')).toMatch(/content,\s*tags/);
      expect(ftsMatches(dbPath, FTS_MARKER_WORD)).toEqual([]);
      expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
    });
  });

  describe('a virtual table that lost only its docsize table', () => {
    beforeEach(async () => {
      await createHealthyDatabase();
      // Every row can still be counted: only the shadow table check sees that it is gone.
      forgetShadowTable(dbPath, 'entries_fts_docsize');
    });

    it('is rebuilt, which gives the shadow table back', async () => {
      (await SqliteEngine.create(dbPath)).close();

      expect(schemaObjects(dbPath).has('entries_fts_docsize')).toBe(true);
      expect(ftsMatches(dbPath, FTS_MARKER_WORD)).toEqual([]);
      expect(ftsRowCount(dbPath)).toBe(SAMPLE_ENTRY_COUNT);
      expect(engineMeta(dbPath).fts_state).toBe('ready');
    });
  });

  describe('a virtual table with every shadow table but a format version SQLite cannot read', () => {
    beforeEach(async () => {
      await createHealthyDatabase();
      withDatabase(dbPath, (db) => {
        db.unsafeMode(true);
        db.exec("UPDATE entries_fts_config SET v = 9 WHERE k = 'version'");
      });
    });

    it('is not taken for healthy: it cannot be read, so full-text search is marked unavailable', async () => {
      const checksumsBefore = tableChecksums(dbPath);

      (await SqliteEngine.create(dbPath)).close();

      expect(engineMeta(dbPath).fts_state).toBe('unavailable');
      expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
    });
  });

  describe('when the full-text module reports its own corruption while the table is rebuilt', () => {
    beforeEach(async () => {
      await createHealthyDatabase();
      withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));
      scenario.moduleReportsCorruption = true;
    });

    it('marks the table unavailable and opens: the user data is not what is damaged', async () => {
      (await SqliteEngine.create(dbPath)).close();

      const meta = engineMeta(dbPath);
      expect(meta.fts_state).toBe('unavailable');
      expect(meta.fts_detail).toMatch(/entries_fts/);
    });
  });

  describe.each(['entries_fts_data', 'entries_fts_content'])(
    'when a page of %s, a table the full-text table keeps its index in, is damaged',
    (shadowTable) => {
      beforeEach(async () => {
        createMaintainerShapedDatabase(dbPath);
        (await SqliteEngine.create(dbPath)).close();
        corruptTablePage(dbPath, shadowTable);
      });

      it('opens and marks the full-text table unavailable: the entries are not what is damaged', async () => {
        const checksumsBefore = tableChecksums(dbPath);

        (await SqliteEngine.create(dbPath)).close();

        const meta = engineMeta(dbPath);
        expect(meta.fts_state).toBe('unavailable');
        expect(meta.fts_detail).toMatch(/entries_fts/);
        expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
      });

      it('still searches and still keeps favorites, usage counts and tags', async () => {
        const engine = await SqliteEngine.create(dbPath);
        try {
          expect(engine.search({ query: 'deployment', limit: 5 }).map((r) => r.entry.id)).toEqual([
            FAVORITE_ID,
          ]);
          expect(engine.toggleFavorite(USED_ID)).toBe(true);
          engine.incrementUsage(USED_ID);
          engine.addTag(USED_ID, 'after-damage');
          expect(engine.getEntry(USED_ID)?.usageCount).toBe(4);
          expect(engine.getTagsForEntry(USED_ID)).toContain('after-damage');
        } finally {
          engine.close();
        }
      });

      it('does not write again on the next open', async () => {
        (await SqliteEngine.create(dbPath)).close();
        const bytesBefore = sha256(dbPath);

        (await SqliteEngine.create(dbPath)).close();

        expect(sha256(dbPath)).toBe(bytesBefore);
      });
    },
  );

  describe('when the entries the table is rebuilt from are damaged', () => {
    beforeEach(async () => {
      createMaintainerShapedDatabase(dbPath);
      (await SqliteEngine.create(dbPath)).close();
      withDatabase(dbPath, (db) => db.exec('DROP TABLE entries_fts'));
      corruptTablePage(dbPath, 'entries');
    });

    it('reports a damaged database instead of recording the table as unavailable', async () => {
      const bytesBefore = sha256(dbPath);
      const filesBefore = filesBeside(tempDir);

      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(DatabaseCorruptError);
      expect((failure as Error).message).toMatch(/restore it from a backup/);
      expect(sha256(dbPath)).toBe(bytesBefore);
      expect(filesBeside(tempDir)).toEqual(filesBefore);
    });
  });

  // The damage is only found once the migrations have been committed, so the error cannot say that
  // the file is unmodified: the schema was brought up to date, with a copy taken first.
  describe('when the entries are damaged in a database that still has to be migrated', () => {
    beforeEach(() => {
      createMaintainerShapedDatabase(dbPath);
      corruptTablePage(dbPath, 'entries');
    });

    it('reports a damaged database that does not claim to be unmodified, and says what was kept', async () => {
      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(DatabaseCorruptError);
      const { message } = failure as Error;
      expect(message).not.toMatch(/database not modified/i);
      expect(message).toMatch(/no entry was changed or deleted/i);
      expect(message).toMatch(/"backups" folder/);
      expect(message).toMatch(/restore it from a backup/);
    });

    it('did bring the schema up to date, and took the copy the message points to first', async () => {
      await failureOf(dbPath);

      expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
      const [backup, ...others] = readdirSync(join(tempDir, 'backups'));
      expect(others).toEqual([]);
      expect(recordedVersions(join(tempDir, 'backups', backup!))).toEqual([1, 2, 3, 4]);
    });

    it('reports the same thing on the next open, and writes nothing more', async () => {
      await failureOf(dbPath);
      const bytesBefore = sha256(dbPath);

      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(DatabaseCorruptError);
      expect(sha256(dbPath)).toBe(bytesBefore);
    });
  });
});
