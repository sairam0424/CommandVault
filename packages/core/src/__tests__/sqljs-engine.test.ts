import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaTooNewError } from '../indexer/db-errors.js';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import {
  FAVORITE_ID,
  USED_ID,
  createLegacyDatabase,
  createMaintainerShapedDatabase,
  engineMeta,
  ftsMatches,
  recordedVersions,
  schemaObjects,
  tableChecksums,
  withDatabase,
  CURRENT_VERSIONS,
} from './migration-fixtures.js';

// The pure-JavaScript backend (what the VS Code extension uses) has no FTS5 module at all. The
// engine has to open, migrate and guard a database on it just the same, and leave the full-text
// table alone for a build that can repair it.

vi.mock('../indexer/database-factory.js', () => ({
  createDatabaseAdapter: (path: string) => SqlJsAdapter.create(path),
}));

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('the engine on the sql.js backend', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-sqljs-engine-'));
    dbPath = join(tempDir, 'vault.db');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a new database at every known version, with full-text search unavailable', async () => {
    const engine = await SqliteEngine.create(dbPath);
    engine.close();

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(engineMeta(dbPath).fts_state).toBe('unavailable');
    expect(schemaObjects(dbPath).has('entries_fts')).toBe(false);
  });

  it("migrates a database shaped like the maintainer's without touching the user data", async () => {
    createMaintainerShapedDatabase(dbPath);
    const checksumsBefore = tableChecksums(dbPath);

    const engine = await SqliteEngine.create(dbPath);
    try {
      expect(engine.search({ query: 'deployment', limit: 5 }).map((r) => r.entry.id)).toEqual([
        FAVORITE_ID,
      ]);
    } finally {
      engine.close();
    }

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(tableChecksums(dbPath)).toEqual(checksumsBefore);
  });

  it('does not save the file again when it is opened a second time', async () => {
    createMaintainerShapedDatabase(dbPath);
    (await SqliteEngine.create(dbPath)).close();
    // An old time stamp: a save, however quick, would move it.
    const longAgo = new Date('2020-01-01T00:00:00Z');
    utimesSync(dbPath, longAgo, longAgo);
    const bytesBefore = sha256(dbPath);

    (await SqliteEngine.create(dbPath)).close();
    (await SqliteEngine.create(dbPath)).close();

    expect(statSync(dbPath).mtimeMs).toBe(longAgo.getTime());
    expect(sha256(dbPath)).toBe(bytesBefore);
  });

  it('writes the safety copy of a database it migrates, as a file copy', async () => {
    createMaintainerShapedDatabase(dbPath);
    const bytesBefore = sha256(dbPath);

    (await SqliteEngine.create(dbPath)).close();

    const [name, ...others] = readdirSync(join(tempDir, 'backups'));
    expect(others).toEqual([]);
    expect(name).toMatch(/^pre-migrate-v4-/);
    const backupPath = join(tempDir, 'backups', name!);
    expect(recordedVersions(backupPath)).toEqual([1, 2, 3, 4]);
    expect(sha256(backupPath)).toBe(bytesBefore);
  });

  it('can write to a database still carrying the 0.1.0 triggers, which it cannot drop the table of', async () => {
    createLegacyDatabase(dbPath);

    const engine = await SqliteEngine.create(dbPath);
    try {
      engine.incrementUsage(USED_ID);
      expect(engine.getEntry(USED_ID)?.usageCount).toBe(4);
    } finally {
      engine.close();
    }

    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    const triggers = schemaObjects(dbPath);
    for (const trigger of ['entries_ai', 'entries_ad', 'entries_au']) {
      expect(triggers.has(trigger)).toBe(false);
    }
  });

  it('refuses a database written by a newer schema and leaves the file byte-identical', async () => {
    createMaintainerShapedDatabase(dbPath);
    withDatabase(dbPath, (db) => {
      db.exec("INSERT INTO schema_version (version, description) VALUES (99, 'from the future')");
      db.exec('CREATE TABLE engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.exec("INSERT INTO engine_meta VALUES ('compatible_from', '99'), ('written_by', '9.9.9')");
      db.pragma('wal_checkpoint(TRUNCATE)');
    });
    const bytesBefore = sha256(dbPath);
    const filesBefore = readdirSync(tempDir).sort();

    const failure = await SqliteEngine.create(dbPath).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SchemaTooNewError);
    expect(sha256(dbPath)).toBe(bytesBefore);
    expect(readdirSync(tempDir).sort()).toEqual(filesBefore);
    expect(existsSync(join(tempDir, 'backups'))).toBe(false);
  });

  it('leaves a full-text table it could not rebuild for a build that can', async () => {
    createMaintainerShapedDatabase(dbPath);
    (await SqliteEngine.create(dbPath)).close();

    // The native engine (the CLI) opens the same file next and builds the table.
    vi.doUnmock('../indexer/database-factory.js');
    vi.resetModules();
    const { SqliteEngine: NativeEngine } = await import('../indexer/sqlite-engine.js');
    (await NativeEngine.create(dbPath)).close();

    expect(engineMeta(dbPath).fts_state).toBe('ready');
    expect(ftsMatches(dbPath, 'deployment')).toEqual([FAVORITE_ID]);
  });
});
