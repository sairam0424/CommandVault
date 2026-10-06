import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseOpenError, SchemaTooNewError } from '../indexer/db-errors.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import { engineMeta, recordedVersions, schemaObjects, withDatabase } from './migration-fixtures.js';

// A database written by a newer schema must not be touched by this build: it could not keep the
// parts it does not know about consistent. The engine refuses, and the file stays as it was.

const NEWER_VERSION = 99;

const scenario = vi.hoisted(() => ({ staleVersions: undefined as number[] | undefined }));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter = await original.createDatabaseAdapter(...args);
      let hasServedStaleRead = false;
      return instrumentAdapter(adapter, {
        // The first read of the applied versions is answered as the state before a newer build
        // migrated the file, the way a slow process sees it.
        answerQuery: (sql) => {
          if (hasServedStaleRead || scenario.staleVersions === undefined) return undefined;
          if (!/FROM schema_version/i.test(sql)) return undefined;
          hasServedStaleRead = true;
          return scenario.staleVersions.map((version) => ({ version }));
        },
      });
    },
  };
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

type JournalMode = 'wal' | 'delete';

interface NewerDatabaseOptions {
  readonly oneMigrationBehind?: boolean;
  /**
   * The journal mode the newer build left the file in. This build switches a file it opens to WAL,
   * so a refusal has to come first; a build that fell back to sql.js leaves 'delete'.
   */
  readonly journalMode?: JournalMode;
}

/** A database the current build wrote, then a newer build (schema 99) wrote to. */
async function writeNewerDatabase(
  path: string,
  meta: Record<string, string> | 'absent',
  options: NewerDatabaseOptions = {},
): Promise<void> {
  (await SqliteEngine.create(path)).close();
  withDatabase(path, (db) => {
    // Without the guard, this build would now go on to apply migration 5 and back the file up.
    if (options.oneMigrationBehind) db.exec('DELETE FROM schema_version WHERE version = 5');
    db.prepare(
      "INSERT INTO schema_version (version, description) VALUES (?, 'from the future')",
    ).run(NEWER_VERSION);
    if (meta === 'absent') {
      db.exec('DROP TABLE IF EXISTS engine_meta');
    } else {
      db.exec('CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const upsert = db.prepare('INSERT OR REPLACE INTO engine_meta (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(meta)) upsert.run(key, value);
    }
    if (options.journalMode === 'delete') db.pragma('journal_mode = DELETE');
  });
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

describe('a database written by a newer schema', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-schema-newer-'));
    dbPath = join(tempDir, 'vault.db');
  });

  afterEach(async () => {
    scenario.staleVersions = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('is refused with SchemaTooNewError, which names the writer and says to upgrade', async () => {
    await writeNewerDatabase(dbPath, { compatible_from: '99', written_by: '9.9.9' });

    const failure = await failureOf(dbPath);

    expect(failure).toBeInstanceOf(SchemaTooNewError);
    expect(failure).toBeInstanceOf(DatabaseOpenError);
    const error = failure as SchemaTooNewError;
    expect(error.name).toBe('SchemaTooNewError');
    expect(error.message).toContain('9.9.9');
    expect(error.message).toMatch(/upgrade/i);
    expect(error.message).toContain(dbPath);
    expect(error.databaseVersion).toBe(NEWER_VERSION);
  });

  it('is refused without naming a writer when the file does not record one', async () => {
    await writeNewerDatabase(dbPath, { compatible_from: '99' });
    withDatabase(dbPath, (db) => db.exec("DELETE FROM engine_meta WHERE key = 'written_by'"));

    const failure = await failureOf(dbPath);

    expect(failure).toBeInstanceOf(SchemaTooNewError);
    expect((failure as SchemaTooNewError).writtenBy).toBeUndefined();
    expect((failure as Error).message).toContain('a newer version of CommandVault');
  });

  describe.each<JournalMode>(['wal', 'delete'])('left in %s journal mode', (journalMode) => {
    it('is left byte-identical, with nothing written beside it', async () => {
      await writeNewerDatabase(
        dbPath,
        { compatible_from: '99', written_by: '9.9.9' },
        { oneMigrationBehind: true, journalMode },
      );
      const bytesBefore = sha256(dbPath);
      const filesBefore = readdirSync(tempDir).sort();

      await failureOf(dbPath);

      expect(sha256(dbPath)).toBe(bytesBefore);
      expect(readdirSync(tempDir).sort()).toEqual(filesBefore);
    });

    it('is refused and left byte-identical when it says nothing about who can read it', async () => {
      await writeNewerDatabase(dbPath, 'absent', { oneMigrationBehind: true, journalMode });
      const bytesBefore = sha256(dbPath);

      const failure = await failureOf(dbPath);

      expect(failure).toBeInstanceOf(SchemaTooNewError);
      expect(sha256(dbPath)).toBe(bytesBefore);
    });
  });

  it('is still refused when a newer build migrated it after this build looked', async () => {
    await writeNewerDatabase(dbPath, { compatible_from: '99', written_by: '9.9.9' });
    const bytesBefore = sha256(dbPath);
    const filesBefore = readdirSync(tempDir).sort();
    // This build believes the file is at schema 4, so it goes on to take the write lock.
    scenario.staleVersions = [1, 2, 3, 4];

    const failure = await failureOf(dbPath);

    expect(failure).toBeInstanceOf(SchemaTooNewError);
    expect(sha256(dbPath)).toBe(bytesBefore);
    expect(readdirSync(tempDir).sort()).toEqual(filesBefore);
  });

  it('is opened when the newer build says this one can still read it', async () => {
    await writeNewerDatabase(dbPath, { compatible_from: '5', written_by: '9.9.9' });

    const engine = await SqliteEngine.create(dbPath);
    engine.close();

    expect(recordedVersions(dbPath)).toContain(NEWER_VERSION);
    expect(engineMeta(dbPath).written_by).toBe('9.9.9');
    expect(schemaObjects(dbPath).has('entries_fts')).toBe(true);
  });
});
