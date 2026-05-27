import { createHash } from 'node:crypto';
import type { VaultEntry, SearchResult, SearchOptions, VaultStats } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';
import { createDatabaseAdapter } from './database-factory.js';
import { EntryStore } from './entry-store.js';
import { TagStore } from './tag-store.js';
import { SnapshotStore } from './snapshot-store.js';
import { StatsStore } from './stats-store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
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
  );

  CREATE TABLE IF NOT EXISTS user_tags (
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(entry_id, tag)
  );

  CREATE TABLE IF NOT EXISTS scan_snapshots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function stableId(type: string, name: string, source: string): string {
  return createHash('sha256').update(`${type}:${name}:${source}`).digest('hex').slice(0, 12);
}

function runAdapterMigrations(conn: DatabaseAdapter): void {
  // Ensure schema_version table exists
  conn.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL
    );
  `);

  const versionRows = conn.queryAll<{ v: number | null }>(
    'SELECT MAX(version) as v FROM schema_version',
  );
  const currentVersion = versionRows[0]?.v ?? 0;

  // Remove legacy FTS artifacts only if we haven't yet created the new FTS5 table (migration 3)
  if (currentVersion < 3) {
    conn.execute('DROP TRIGGER IF EXISTS entries_ai');
    conn.execute('DROP TRIGGER IF EXISTS entries_ad');
    conn.execute('DROP TRIGGER IF EXISTS entries_au');
    for (const suffix of ['_data', '_idx', '_docsize', '_config']) {
      conn.execute(`DROP TABLE IF EXISTS entries_fts${suffix}`);
    }
    try {
      conn.execute('PRAGMA writable_schema = ON');
      conn.execute("DELETE FROM sqlite_master WHERE name = 'entries_fts' AND type = 'table'");
      conn.execute('PRAGMA writable_schema = OFF');
    } catch {
      // better-sqlite3 may not allow sqlite_master modification — safe to skip
      // since the FTS shadow tables were already dropped above
    }
  }

  // Migration 1: entry_tags junction table
  if (currentVersion < 1) {
    conn.transaction(() => {
      conn.execute(`
        CREATE TABLE IF NOT EXISTS entry_tags (
          entry_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (entry_id, tag)
        );
      `);
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag)');
      conn.execute(
        "INSERT INTO schema_version (version, description) VALUES (1, 'Add entry_tags junction table for exact tag matching')",
      );
    });
  }

  // Migration 2: stable IDs
  if (currentVersion < 2) {
    conn.transaction(() => {
      const rows = conn.queryAll<{ id: string; name: string; type: string; source: string }>(
        'SELECT id, name, type, source FROM entries',
      );

      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const newId = stableId(row.type, row.name, row.source);
        const existing = groups.get(newId) ?? [];
        groups.set(newId, [...existing, row.id]);
      }

      for (const [newId, oldIds] of groups) {
        for (let i = 1; i < oldIds.length; i++) {
          conn.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: oldIds[i] });
          conn.execute('DELETE FROM user_tags WHERE entry_id = $id', { $id: oldIds[i] });
          conn.execute('DELETE FROM scan_snapshots WHERE id = $id', { $id: oldIds[i] });
          conn.execute('DELETE FROM entries WHERE id = $id', { $id: oldIds[i] });
        }
        if (newId !== oldIds[0]) {
          conn.execute('UPDATE entries SET id = $new WHERE id = $old', {
            $new: newId,
            $old: oldIds[0],
          });
          conn.execute('UPDATE user_tags SET entry_id = $new WHERE entry_id = $old', {
            $new: newId,
            $old: oldIds[0],
          });
          conn.execute('UPDATE entry_tags SET entry_id = $new WHERE entry_id = $old', {
            $new: newId,
            $old: oldIds[0],
          });
          conn.execute('UPDATE scan_snapshots SET id = $new WHERE id = $old', {
            $new: newId,
            $old: oldIds[0],
          });
        }
      }

      conn.execute(
        "INSERT INTO schema_version (version, description) VALUES (2, 'Migrate entry IDs from filePath-based to type+name-based')",
      );
    });
  }

  // Migration 3: FTS5 full-text search + column indexes
  if (currentVersion < 3) {
    conn.transaction(() => {
      // Create standalone FTS5 virtual table (not content-synced to avoid rowid issues)
      conn.execute(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          id UNINDEXED,
          name,
          description,
          content,
          tags
        )
      `);

      // Column indexes for common filter queries
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)');
      conn.execute('CREATE INDEX IF NOT EXISTS idx_entries_favorite ON entries(favorite)');

      // Populate FTS5 from existing entries
      conn.execute(`
        INSERT INTO entries_fts(id, name, description, content, tags)
        SELECT id, name, description, content, tags FROM entries
      `);

      conn.execute(
        "INSERT INTO schema_version (version, description) VALUES (3, 'Add FTS5 full-text search table and column indexes')",
      );
    });
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
    const conn = await createDatabaseAdapter(dbPath);

    // Initialize base schema
    for (const statement of SCHEMA.split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      conn.execute(statement);
    }

    // Run migrations
    runAdapterMigrations(conn);

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
