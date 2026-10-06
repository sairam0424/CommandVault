import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  USED_ID,
  createBaseHealthyDatabase,
  createLegacyDatabase,
  engineMeta,
  recordedVersions,
  schemaObjects,
  withDatabase,
  withReadonlyDatabase,
  CURRENT_VERSIONS,
} from './migration-fixtures.js';

// Migrations are gated on the set of versions a database has recorded, not on the highest one, and
// a database that is fully migrated is opened without taking any write lock.

/** One descriptor for the mtime and the bytes, so both describe the same version of the file. */
function snapshotFile(filePath: string): { sha256: string; mtimeMs: number } {
  const fd = openSync(filePath, 'r');
  try {
    const { mtimeMs } = fstatSync(fd);
    return { sha256: createHash('sha256').update(readFileSync(fd)).digest('hex'), mtimeMs };
  } finally {
    closeSync(fd);
  }
}

const scenario = vi.hoisted(() => ({ transactionModes: [] as Array<string | undefined> }));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) =>
      instrumentAdapter(await original.createDatabaseAdapter(...args), {
        onTransaction: (options) => scenario.transactionModes.push(options?.mode),
      }),
  };
});

function corePackageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../../package.json') as { version: string }).version;
}

function journalMode(path: string): string {
  return withReadonlyDatabase(path, (db) => db.pragma('journal_mode', { simple: true }) as string);
}

describe('migration gating', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-migration-gating-'));
    dbPath = join(tempDir, 'vault.db');
    scenario.transactionModes = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('records a new database at every known version', async () => {
    (await SqliteEngine.create(dbPath)).close();

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
  });

  it('seeds engine_meta with the writer, the compatibility floor and the full-text state', async () => {
    (await SqliteEngine.create(dbPath)).close();

    const meta = engineMeta(dbPath);
    expect(meta.written_by).toBe(corePackageVersion());
    expect(meta.compatible_from).toBe('5');
    expect(meta.fts_state).toBe('ready');
  });

  it('applies a migration whose record is missing although later ones are recorded', async () => {
    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) => {
      db.exec('DELETE FROM schema_version WHERE version = 4');
      db.exec('DROP INDEX idx_entries_last_modified');
    });

    (await SqliteEngine.create(dbPath)).close();

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(schemaObjects(dbPath).has('idx_entries_last_modified')).toBe(true);
  });

  it('applies an earlier migration left out of a database that recorded later ones', async () => {
    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) => {
      db.exec('DELETE FROM schema_version WHERE version = 3');
      db.exec('DROP INDEX idx_entries_type');
    });

    (await SqliteEngine.create(dbPath)).close();

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(schemaObjects(dbPath).has('idx_entries_type')).toBe(true);
  });

  it('opens a database that is fully migrated without starting any transaction', async () => {
    (await SqliteEngine.create(dbPath)).close();
    scenario.transactionModes = [];

    (await SqliteEngine.create(dbPath)).close();

    expect(scenario.transactionModes).toEqual([]);
  });

  it('opens a database that is fully migrated without writing a single byte', async () => {
    (await SqliteEngine.create(dbPath)).close();
    const before = snapshotFile(dbPath);
    const probe = new Database(dbPath);
    const dataVersionBefore = probe.pragma('data_version', { simple: true });

    (await SqliteEngine.create(dbPath)).close();

    expect(probe.pragma('data_version', { simple: true })).toBe(dataVersionBefore);
    probe.close();
    const after = snapshotFile(dbPath);
    expect(after.sha256).toBe(before.sha256);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('takes the write lock when the transaction starts, not when it first writes', async () => {
    createLegacyDatabase(dbPath);

    (await SqliteEngine.create(dbPath)).close();

    expect(scenario.transactionModes.length).toBeGreaterThan(0);
    expect(scenario.transactionModes).toEqual(scenario.transactionModes.map(() => 'immediate'));
  });

  it('runs every missing migration in a single transaction', async () => {
    createLegacyDatabase(dbPath);

    (await SqliteEngine.create(dbPath)).close();

    // One transaction for the migrations, one for building the full-text table.
    expect(scenario.transactionModes).toEqual(['immediate', 'immediate']);
  });

  it('takes the write lock when it records the state of a full-text table it finds healthy', async () => {
    // The most common database there is: a released 0.1.7 built it, schema 1-4, the full-text table
    // healthy. Migration 5 leaves its state 'pending', and recording 'ready' is a second write that
    // several processes opening the file at once would otherwise upgrade from a read lock.
    createBaseHealthyDatabase(dbPath);

    (await SqliteEngine.create(dbPath)).close();

    expect(engineMeta(dbPath).fts_state).toBe('ready');
    expect(scenario.transactionModes).toEqual(['immediate', 'immediate']);
  });

  it('switches a database it migrates from rollback-journal to write-ahead logging', async () => {
    createLegacyDatabase(dbPath);
    expect(journalMode(dbPath)).toBe('delete');

    (await SqliteEngine.create(dbPath)).close();

    expect(journalMode(dbPath)).toBe('wal');
  });

  it('switches a database that needs no migration too', async () => {
    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) => db.pragma('journal_mode = DELETE'));

    (await SqliteEngine.create(dbPath)).close();

    expect(journalMode(dbPath)).toBe('wal');
  });

  it('gives engine_meta back to a database that recorded migration 5 but lost the table', async () => {
    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) => db.exec('DROP TABLE engine_meta'));

    (await SqliteEngine.create(dbPath)).close();

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(engineMeta(dbPath)).toMatchObject({ compatible_from: '5', fts_state: 'ready' });
    // Repaired once: the next open finds nothing to do.
    const bytesBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    (await SqliteEngine.create(dbPath)).close();
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(bytesBefore);
  });

  it('creates again the tables of the base schema that a fully migrated database lost', async () => {
    (await SqliteEngine.create(dbPath)).close();
    withDatabase(dbPath, (db) => {
      db.exec('DROP TABLE scan_snapshots');
      db.exec('DROP TABLE user_tags');
    });

    const engine = await SqliteEngine.create(dbPath);
    try {
      engine.addTag(USED_ID, 'after-the-loss');
      engine.saveSnapshot([]);
      expect(engine.getTagsForEntry(USED_ID)).toEqual(['after-the-loss']);
    } finally {
      engine.close();
    }

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    // Nothing was migrated, so there was nothing to take a safety copy of.
    expect(existsSync(join(tempDir, 'backups'))).toBe(false);
    // Repaired once: the next open finds nothing to do.
    const bytesBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    scenario.transactionModes = [];
    (await SqliteEngine.create(dbPath)).close();
    expect(scenario.transactionModes).toEqual([]);
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(bytesBefore);
  });
});
