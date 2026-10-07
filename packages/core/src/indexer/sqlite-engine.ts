import type { VaultEntry, SearchResult, SearchOptions, VaultStats } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';
import { createDatabaseAdapter } from './database-factory.js';
import {
  classifyOpenError,
  errorCode,
  errorMessage,
  toOpenError,
  type FileState,
} from './db-errors.js';
import { EntryStore } from './entry-store.js';
import {
  dropLegacyFtsTriggers,
  hasLegacyFtsTriggers,
  migrateDatabase,
  readEngineMeta,
  writeEngineMeta,
} from './migrations.js';
import { TagStore } from './tag-store.js';
import { SnapshotStore } from './snapshot-store.js';
import { StatsStore } from './stats-store.js';

const FTS_TABLE = 'entries_fts';
const FTS_DEFINITION = `CREATE VIRTUAL TABLE ${FTS_TABLE} USING fts5(id UNINDEXED, name, description, content, tags)`;
const FTS_SHADOW_SUFFIXES = ['data', 'idx', 'content', 'docsize', 'config'] as const;
// `entries_fts_`: the prefix of the shadow tables, and of any that outlived their virtual table.
const FTS_SHADOW_PREFIX_LENGTH = `${FTS_TABLE}_`.length;

type FtsState = 'ready' | 'unavailable';

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/** Whitespace and case carry no meaning in a definition; compare the rest. */
function normalizeDefinition(sql: string): string {
  return sql.replace(/\s+/g, '').toLowerCase();
}

function isFts5Available(conn: DatabaseAdapter): boolean {
  return (
    conn.queryOne("SELECT 1 AS present FROM pragma_module_list WHERE name = 'fts5'") !== undefined
  );
}

function ftsSchemaObjects(conn: DatabaseAdapter): SchemaObject[] {
  return conn.queryAll<SchemaObject>(
    `SELECT type, name, sql FROM sqlite_master
     WHERE name = $table OR substr(name, 1, $prefixLength) = $prefix OR type = 'trigger'`,
    { $table: FTS_TABLE, $prefixLength: FTS_SHADOW_PREFIX_LENGTH, $prefix: `${FTS_TABLE}_` },
  );
}

function canCountFtsRows(conn: DatabaseAdapter): boolean {
  try {
    conn.queryOne(`SELECT count(*) AS n FROM ${FTS_TABLE}`);
    return true;
  } catch (error) {
    // A lock says nothing about the table; let the caller meet it where it has to wait for one.
    if (classifyOpenError(error) === 'locked') throw error;
    return false;
  }
}

/**
 * Healthy means: the virtual table exists with the definition this build searches, all its shadow
 * tables exist, no 0.1.0 trigger is left to write to it, and SQLite can read it. The rows are not
 * compared with `entries`: a healthy table is not rewritten on every open.
 */
function isFtsHealthy(conn: DatabaseAdapter): boolean {
  const objects = ftsSchemaObjects(conn);
  const table = objects.find(({ type, name }) => type === 'table' && name === FTS_TABLE);
  if (table?.sql == null) return false;
  if (normalizeDefinition(table.sql) !== normalizeDefinition(FTS_DEFINITION)) return false;

  const shadows = new Set(objects.filter(({ type }) => type === 'table').map(({ name }) => name));
  if (!FTS_SHADOW_SUFFIXES.every((suffix) => shadows.has(`${FTS_TABLE}_${suffix}`))) return false;
  if (
    hasLegacyFtsTriggers(objects.filter(({ type }) => type === 'trigger').map(({ name }) => name))
  ) {
    return false;
  }
  return canCountFtsRows(conn);
}

/**
 * Drops whatever is left of the full-text table and builds it again from `entries`. The virtual
 * table goes first, taking its shadow tables with it: SQLite refuses to drop a shadow table of a
 * live virtual table, but a plain table that only carries the name is dropped like any other.
 */
function rebuildFts(conn: DatabaseAdapter): void {
  dropLegacyFtsTriggers(conn);
  const objects = ftsSchemaObjects(conn);
  if (objects.some(({ type, name }) => type === 'table' && name === FTS_TABLE)) {
    conn.execute(`DROP TABLE ${FTS_TABLE}`);
  }
  const leftovers = ftsSchemaObjects(conn).filter(
    ({ type, name }) => type === 'table' && name !== FTS_TABLE && name.startsWith(`${FTS_TABLE}_`),
  );
  for (const { name } of leftovers) conn.execute(`DROP TABLE "${name.replaceAll('"', '""')}"`);

  conn.execute(FTS_DEFINITION);
  conn.execute(`
    INSERT INTO entries_fts(id, name, description, content, tags)
    SELECT id, name, description, content, tags FROM entries
  `);
}

function ftsStateRecord(state: FtsState, detail: string): Record<string, string> {
  return { fts_state: state, fts_detail: detail };
}

function isFtsStateRecorded(conn: DatabaseAdapter, state: FtsState, detail: string): boolean {
  const meta = readEngineMeta(conn);
  return meta.get('fts_state') === state && (meta.get('fts_detail') ?? '') === detail;
}

/**
 * Whether the last process to record the table's state could not use it. Without fts5 (the
 * pure-JavaScript backend) index() writes the entries past the table, so however healthy it looks,
 * its rows are no longer those of `entries`.
 */
function isFtsLeftBehind(conn: DatabaseAdapter): boolean {
  return readEngineMeta(conn).get('fts_state') === 'unavailable';
}

/** Writes only when the record differs, so that an open which changes nothing writes nothing. */
function recordFtsState(conn: DatabaseAdapter, state: FtsState, detail: string): void {
  if (isFtsStateRecorded(conn, state, detail)) return;
  conn.transaction(
    () => {
      if (!isFtsStateRecorded(conn, state, detail)) {
        writeEngineMeta(conn, ftsStateRecord(state, detail));
      }
    },
    { mode: 'immediate' },
  );
}

/**
 * Whether `entries`, the user's own data, can be read end to end. Summing the length of `content`
 * makes SQLite read every row in full, overflow pages included, where a bare count(*) may be
 * answered from an index.
 */
function canReadEntries(conn: DatabaseAdapter): boolean {
  try {
    conn.queryOne('SELECT count(*) AS n, coalesce(sum(length(content)), 0) AS bytes FROM entries');
    return true;
  } catch (error) {
    if (classifyOpenError(error) === 'corrupt') return false;
    throw error;
  }
}

/**
 * SQLite itself reported that the table cannot be repaired, e.g. a virtual table it cannot load, a
 * module that calls its own tables corrupt, or a damaged page of one of them (dropping the table
 * has to read its pages too). SQLite reports a bad page of `entries` with the same code, so the
 * code alone proves nothing: the table counts as unavailable only when the entries can still be
 * read. If they cannot, the database is damaged, and it reaches the caller as one.
 */
function isUnrepairable(conn: DatabaseAdapter, error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined || !code.startsWith('SQLITE_')) return false;
  const kind = classifyOpenError(error);
  return kind === 'corrupt' ? canReadEntries(conn) : kind === 'unknown';
}

/**
 * Makes sure the full-text table works, on every open. A database can lose it without losing its
 * recorded version (the maintainer's did: schema 1-4, no entries_fts, a plain entries_fts_content
 * left over), and migrations are not run again for a version that is recorded.
 *
 * Without the fts5 module, or with a table SQLite cannot repair, the state is recorded as
 * `unavailable` and nothing is thrown: full-text search only serves one search tier. A healthy
 * table left behind that way is filled again, once, by the next process that can use it.
 */
function ensureFts(conn: DatabaseAdapter): void {
  if (!isFts5Available(conn)) {
    recordFtsState(conn, 'unavailable', 'the SQLite build has no fts5 module');
    return;
  }
  if (isFtsHealthy(conn) && !isFtsLeftBehind(conn)) {
    recordFtsState(conn, 'ready', '');
    return;
  }
  try {
    conn.transaction(
      () => {
        // Another process may have rebuilt it while this one waited for the write lock.
        if (!isFtsHealthy(conn) || isFtsLeftBehind(conn)) rebuildFts(conn);
        writeEngineMeta(conn, ftsStateRecord('ready', ''));
      },
      { mode: 'immediate' },
    );
  } catch (error) {
    if (!isUnrepairable(conn, error)) throw error;
    recordFtsState(conn, 'unavailable', `cannot repair ${FTS_TABLE}: ${errorMessage(error)}`);
  }
}

export class SqliteEngine {
  private readonly conn: DatabaseAdapter;
  private readonly entryStore: EntryStore;
  private readonly tagStore: TagStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly statsStore: StatsStore;

  private constructor(conn: DatabaseAdapter) {
    this.conn = conn;
    this.entryStore = new EntryStore(conn);
    this.tagStore = new TagStore(conn);
    this.snapshotStore = new SnapshotStore(conn);
    this.statsStore = new StatsStore(conn);
  }

  static async create(dbPath: string): Promise<SqliteEngine> {
    // Opened without write-ahead logging: that switch rewrites the header of a file in rollback
    // mode, and a database written by a newer schema must be refused before anything is written.
    const conn = await createDatabaseAdapter(dbPath, { walMode: false });
    // What a failure may say about the file depends on how far the open got; see FileState.
    let fileState: FileState = 'unmodified';

    try {
      migrateDatabase(conn, {
        onAccepted: () => {
          conn.enableWriteAheadLog();
          fileState = 'journal-switched';
        },
      });
      fileState = 'entries-untouched';
      ensureFts(conn);
    } catch (error) {
      // Release the file handle: on Windows an open handle blocks deleting or renaming vault.db.
      try {
        conn.close();
      } catch {
        // close() can fail too (sql.js flushes to disk first); the error that got us here is the
        // one worth reporting.
      }
      // A lock that outlasted the busy timeout, a read-only file and the like get their typed error.
      throw toOpenError(error, dbPath, fileState);
    }

    return new SqliteEngine(conn);
  }

  index(entries: readonly VaultEntry[], changedIds?: ReadonlySet<string>): void {
    this.entryStore.index(entries, changedIds);
  }

  search(options: SearchOptions): SearchResult[] {
    return this.entryStore.search(options);
  }

  toggleFavorite(id: string): boolean {
    return this.entryStore.toggleFavorite(id);
  }

  incrementUsage(id: string): void {
    this.entryStore.incrementUsage(id);
  }

  getEntry(id: string): VaultEntry | undefined {
    return this.entryStore.getEntry(id);
  }

  getStats(): VaultStats {
    return this.statsStore.getStats();
  }

  addTag(entryId: string, tag: string): void {
    this.tagStore.addTag(entryId, tag);
    this.entryStore.invalidateTagCache();
  }

  removeTag(entryId: string, tag: string): void {
    this.tagStore.removeTag(entryId, tag);
    this.entryStore.invalidateTagCache();
  }

  getTagsForEntry(entryId: string): string[] {
    return this.tagStore.getTagsForEntry(entryId);
  }

  saveSnapshot(entries: readonly VaultEntry[]): void {
    this.snapshotStore.saveSnapshot(entries);
  }

  getDiff(currentEntries: readonly VaultEntry[]): {
    added: VaultEntry[];
    removed: string[];
    modified: VaultEntry[];
  } {
    return this.snapshotStore.getDiff(currentEntries);
  }

  close(): void {
    this.conn.close();
  }
}
