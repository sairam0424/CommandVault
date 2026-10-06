import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseAdapter } from './database-adapter.js';
import { MigrationBackupError, SchemaTooNewError, errorCode, errorMessage } from './db-errors.js';
import { orWhenMissing } from './quarantine-fs.js';

/**
 * The schema and the migrations that bring a database to it.
 *
 * A migration runs when its version is missing from `schema_version`, whatever the highest recorded
 * version is. All the missing ones run in one `BEGIN IMMEDIATE` transaction, after the applied
 * versions have been read again under the write lock, so that processes opening the same old
 * database at once take turns instead of colliding: the first migrates, the rest find nothing to do.
 * A database that is already current (every version recorded, every base table there) is opened
 * without taking a write lock at all.
 */

interface Migration {
  readonly version: number;
  readonly description: string;
  readonly apply: (conn: DatabaseAdapter) => void;
}

/**
 * The tables every version of the engine needs, by name. They are created when a migration runs and
 * again, if one has been lost, when a database that has every version recorded is opened.
 */
const BASE_SCHEMA: Readonly<Record<string, string>> = {
  schema_version: `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL
  )`,
  entries: `CREATE TABLE IF NOT EXISTS entries (
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
  user_tags: `CREATE TABLE IF NOT EXISTS user_tags (
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(entry_id, tag)
  )`,
  scan_snapshots: `CREATE TABLE IF NOT EXISTS scan_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
};

/** The triggers @commandvault/core 0.1.0 used to keep its external-content FTS table in sync. */
const LEGACY_FTS_TRIGGERS = ['entries_ai', 'entries_ad', 'entries_au'] as const;

/** Builds that know a schema at least this new can read what this build writes. */
const COMPATIBLE_FROM = 5;

const BACKUP_DIR = 'backups';
const BACKUP_DIR_MODE = 0o700;
const KEPT_BACKUPS = 3;
const UNFINISHED_SUFFIX = '.partial';
const IN_MEMORY_PATH = ':memory:';
// `pre-migrate-v<schema version it was taken at>-<UTC time to the millisecond>-<process id>.db`
const BACKUP_FILE = /^pre-migrate-v\d+-(\d{8}T\d{9}Z)(?:-\d+)?\.db$/;
// A copy still being written, and the rollback journal SQLite keeps beside it (`<copy>-journal`),
// which a killed process leaves behind as well.
const UNFINISHED_BACKUP_FILE = /^pre-migrate-v\d+-\d{8}T\d{9}Z(?:-\d+)?\.db\.partial(?:-journal)?$/;

function stableId(type: string, name: string, source: string): string {
  return createHash('sha256').update(`${type}:${name}:${source}`).digest('hex').slice(0, 12);
}

/**
 * The package version, recorded as the writer of the file. Informational: a bundler that emits
 * CommonJS (the VS Code extension) has no `import.meta.url`, and then no writer is recorded.
 */
function corePackageVersion(): string | undefined {
  const moduleUrl: unknown = import.meta.url;
  if (typeof moduleUrl !== 'string') return undefined;
  try {
    const manifest = createRequire(moduleUrl)('../../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    // Not running from a package layout; the writer is only recorded for people reading the file.
    return undefined;
  }
}

function addEntryTags(conn: DatabaseAdapter): void {
  conn.execute(`
    CREATE TABLE IF NOT EXISTS entry_tags (
      entry_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (entry_id, tag)
    )
  `);
  conn.execute('CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag)');
}

function assignStableIds(conn: DatabaseAdapter): void {
  const rows = conn.queryAll<{ id: string; name: string; type: string; source: string }>(
    'SELECT id, name, type, source FROM entries',
  );

  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const newId = stableId(row.type, row.name, row.source);
    groups.set(newId, [...(groups.get(newId) ?? []), row.id]);
  }

  for (const [newId, oldIds] of groups) {
    for (const duplicate of oldIds.slice(1)) {
      conn.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: duplicate });
      conn.execute('DELETE FROM user_tags WHERE entry_id = $id', { $id: duplicate });
      conn.execute('DELETE FROM scan_snapshots WHERE id = $id', { $id: duplicate });
      conn.execute('DELETE FROM entries WHERE id = $id', { $id: duplicate });
    }
    if (newId !== oldIds[0]) renameEntry(conn, oldIds[0]!, newId);
  }
}

function renameEntry(conn: DatabaseAdapter, oldId: string, newId: string): void {
  const params = { $new: newId, $old: oldId };
  conn.execute('UPDATE entries SET id = $new WHERE id = $old', params);
  conn.execute('UPDATE user_tags SET entry_id = $new WHERE entry_id = $old', params);
  conn.execute('UPDATE entry_tags SET entry_id = $new WHERE entry_id = $old', params);
  conn.execute('UPDATE scan_snapshots SET id = $new WHERE id = $old', params);
}

function addEngineMeta(conn: DatabaseAdapter): void {
  conn.execute(
    'CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  // The full-text table is built right after the migrations, see ensureFts in sqlite-engine.ts.
  const seeds = { compatible_from: String(COMPATIBLE_FROM), fts_state: 'pending' };
  for (const [key, value] of Object.entries(seeds)) {
    conn.execute('INSERT OR IGNORE INTO engine_meta (key, value) VALUES ($key, $value)', {
      $key: key,
      $value: value,
    });
  }
}

// The full-text table itself is not a migration: it is checked, and rebuilt if need be, on every
// open (ensureFts), so that a database whose table went missing does not stay broken for good.
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Add entry_tags junction table for exact tag matching',
    apply: addEntryTags,
  },
  {
    version: 2,
    description: 'Migrate entry IDs from filePath-based to type+name-based',
    apply: assignStableIds,
  },
  {
    version: 3,
    description: 'Add column indexes for common filter queries',
    apply: (conn) => {
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entries_favorite ON entries(favorite)');
    },
  },
  {
    version: 4,
    description: 'Add last_modified index for date range filters',
    apply: (conn) =>
      conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_entries_last_modified ON entries(last_modified)',
      ),
  },
  {
    version: 5,
    description: 'Add engine_meta: writer, compatibility floor and full-text state',
    apply: addEngineMeta,
  },
];

/** The newest schema this build knows how to read and write. */
export const KNOWN_SCHEMA_VERSION = Math.max(...MIGRATIONS.map(({ version }) => version));

function tableExists(conn: DatabaseAdapter, name: string): boolean {
  return (
    conn.queryOne("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = $name", {
      $name: name,
    }) !== undefined
  );
}

function hasBaseTables(conn: DatabaseAdapter): boolean {
  const present = new Set(
    conn
      .queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map(({ name }) => name),
  );
  return Object.keys(BASE_SCHEMA).every((name) => present.has(name));
}

function createBaseTables(conn: DatabaseAdapter): void {
  for (const statement of Object.values(BASE_SCHEMA)) conn.execute(statement);
}

function readAppliedVersions(conn: DatabaseAdapter): ReadonlySet<number> {
  if (!tableExists(conn, 'schema_version')) return new Set();
  const rows = conn.queryAll<{ version: number }>('SELECT version FROM schema_version');
  return new Set(rows.map((row) => row.version));
}

function missingMigrations(applied: ReadonlySet<number>): Migration[] {
  return MIGRATIONS.filter(({ version }) => !applied.has(version));
}

/** Everything in `engine_meta`; empty for a database that has none yet. */
export function readEngineMeta(conn: DatabaseAdapter): ReadonlyMap<string, string> {
  if (!tableExists(conn, 'engine_meta')) return new Map();
  const rows = conn.queryAll<{ key: string; value: string }>('SELECT key, value FROM engine_meta');
  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * Records entries in `engine_meta`. A database that recorded migration 5 but lost the table (by
 * hand, or in a partial restore) is given it back here, seeds included: migrations are not run
 * again for a version that is recorded, so nothing else would ever repair it.
 */
export function writeEngineMeta(
  conn: DatabaseAdapter,
  entries: Readonly<Record<string, string>>,
): void {
  addEngineMeta(conn);
  for (const [key, value] of Object.entries(entries)) {
    conn.execute(
      `INSERT INTO engine_meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      { $key: key, $value: value },
    );
  }
}

export function dropLegacyFtsTriggers(conn: DatabaseAdapter): void {
  for (const trigger of LEGACY_FTS_TRIGGERS) conn.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
}

export function hasLegacyFtsTriggers(names: readonly string[]): boolean {
  return names.some((name) => (LEGACY_FTS_TRIGGERS as readonly string[]).includes(name));
}

/**
 * Refuses a database written by a newer schema than this build knows, unless that build declared
 * (`compatible_from`) that builds like this one can still read it. A file that is ahead and does
 * not say so is not opened: it could not be kept consistent.
 */
function assertNotNewer(conn: DatabaseAdapter, applied: ReadonlySet<number>): void {
  const newest = Math.max(0, ...applied);
  if (newest <= KNOWN_SCHEMA_VERSION) return;

  const meta = readEngineMeta(conn);
  const declared = meta.get('compatible_from') ?? '';
  if (/^\d+$/.test(declared) && Number(declared) <= KNOWN_SCHEMA_VERSION) return;

  throw new SchemaTooNewError(conn.path, {
    databaseVersion: newest,
    supportedVersion: KNOWN_SCHEMA_VERSION,
    writtenBy: meta.get('written_by'),
  });
}

function isEmptyDatabase(conn: DatabaseAdapter): boolean {
  const row = conn.queryOne<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  return (row?.n ?? 0) === 0;
}

function backupFileName(fromVersion: number): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `pre-migrate-v${fromVersion}-${stamp}-${process.pid}.db`;
}

/**
 * A consistent copy of a database that holds something, taken under the write lock before the
 * first migration changes it, so that it is exactly the state the migrations start from and no
 * other process writes in between. Not for a new or in-memory database: there is nothing to lose.
 * If the copy cannot be written the migration does not happen, because it would run without a way
 * back.
 *
 * The copy is written under a temporary name and renamed when complete, so that every file named
 * like a backup is a whole one, also after a crash. Only the holder of the write lock writes one,
 * so a temporary file found on the way is left by a crash and is removed.
 */
function backupBeforeMigrating(
  conn: DatabaseAdapter,
  applied: ReadonlySet<number>,
): string | undefined {
  if (conn.path === IN_MEMORY_PATH || isEmptyDatabase(conn)) return undefined;

  const dir = join(dirname(conn.path), BACKUP_DIR);
  const destination = join(dir, backupFileName(Math.max(0, ...applied)));
  const unfinished = `${destination}${UNFINISHED_SUFFIX}`;
  try {
    mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
    discardUnfinishedBackups(dir);
    conn.backupTo(unfinished);
    renameSync(unfinished, destination);
  } catch (error) {
    discardFile(unfinished);
    throw new MigrationBackupError(conn.path, destination, error);
  }
  return destination;
}

function warn(message: string): void {
  process.stderr.write(`CommandVault: ${message}\n`);
}

/** Cleanup that must not turn a finished migration, or the error that ended one, into another. */
function discardFile(path: string): void {
  try {
    orWhenMissing(undefined, () => unlinkSync(path));
  } catch (error) {
    warn(`could not remove ${path}: ${errorMessage(error)}`);
  }
}

function removeDirectoryIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
      warn(`could not remove ${dir}: ${errorMessage(error)}`);
    }
  }
}

function pruneBackups(dir: string): void {
  try {
    const stamped = readdirSync(dir).flatMap((name) => {
      const stamp = BACKUP_FILE.exec(name)?.[1];
      return stamp === undefined ? [] : [{ name, stamp }];
    });
    // Newest first by the time in the name: the version in front of it sorts 10 before 2 as text.
    stamped.sort((a, b) => b.stamp.localeCompare(a.stamp) || b.name.localeCompare(a.name));
    for (const { name } of stamped.slice(KEPT_BACKUPS)) discardFile(join(dir, name));
  } catch (error) {
    warn(`could not tidy ${dir}: ${errorMessage(error)}`);
  }
}

function discardUnfinishedBackups(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (UNFINISHED_BACKUP_FILE.test(name)) discardFile(join(dir, name));
  }
}

/** A backup whose migration did not happen protects nothing, and the folder may be its alone. */
function discardBackup(backup: string): void {
  discardFile(backup);
  removeDirectoryIfEmpty(dirname(backup));
}

type MigrationOutcome =
  { readonly migrated: false } | { readonly migrated: true; readonly backup: string | undefined };

function runMigrations(conn: DatabaseAdapter, missing: readonly Migration[]): void {
  createBaseTables(conn);
  // Written to a table that is being replaced, these would fail or corrupt every write to entries.
  dropLegacyFtsTriggers(conn);
  for (const migration of missing) {
    migration.apply(conn);
    conn.execute(
      'INSERT INTO schema_version (version, description) VALUES ($version, $description)',
      {
        $version: migration.version,
        $description: migration.description,
      },
    );
  }
  const writer = corePackageVersion();
  if (writer !== undefined) writeEngineMeta(conn, { written_by: writer });
}

/**
 * Runs inside the write transaction, so what it reads is what it changes: the applied versions,
 * the newer-schema guard, the backup and the migrations all see the same file. Not migrated when
 * another process got there first.
 */
function applyMissingMigrations(conn: DatabaseAdapter): MigrationOutcome {
  const applied = readAppliedVersions(conn);
  assertNotNewer(conn, applied);
  const missing = missingMigrations(applied);
  if (missing.length === 0) {
    // Nothing to migrate, so nothing to lose; a base table that went missing is given back empty.
    createBaseTables(conn);
    return { migrated: false };
  }

  const backup = backupBeforeMigrating(conn, applied);
  try {
    runMigrations(conn, missing);
  } catch (error) {
    if (backup !== undefined) discardBackup(backup);
    throw error;
  }
  return { migrated: true, backup };
}

export interface MigrateOptions {
  /**
   * Called once the file is known not to be ahead of this build, before anything is written to it:
   * the moment to change settings that are kept in the file itself, such as its journal mode.
   */
  readonly onAccepted?: () => void;
}

/**
 * Brings the database to the schema this build knows. Throws SchemaTooNewError (writing nothing)
 * for a file that is ahead, MigrationBackupError if the safety copy cannot be made, and leaves the
 * file as it was if anything fails part of the way.
 */
export function migrateDatabase(conn: DatabaseAdapter, options: MigrateOptions = {}): void {
  const applied = readAppliedVersions(conn);
  assertNotNewer(conn, applied);
  options.onAccepted?.();
  if (missingMigrations(applied).length === 0 && hasBaseTables(conn)) return;

  const outcome = conn.transaction(() => applyMissingMigrations(conn), { mode: 'immediate' });
  if (outcome.migrated && outcome.backup !== undefined) pruneBackups(dirname(outcome.backup));
}
