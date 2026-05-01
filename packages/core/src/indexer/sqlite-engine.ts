import Database from 'better-sqlite3';
import type { VaultEntry, SearchResult, SearchOptions, VaultStats, EntryType } from '../types/index.js';

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

  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    name, description, tags, content,
    content='entries',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, name, description, tags, content)
    VALUES (new.rowid, new.name, new.description, new.tags, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, name, description, tags, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, name, description, tags, content)
    VALUES ('delete', old.rowid, old.name, old.description, old.tags, old.content);
    INSERT INTO entries_fts(rowid, name, description, tags, content)
    VALUES (new.rowid, new.name, new.description, new.tags, new.content);
  END;
`;

interface EntryRow {
  id: string;
  name: string;
  type: string;
  source: string;
  description: string;
  file_path: string;
  tags: string;
  metadata: string;
  content: string;
  last_modified: string;
  favorite: number;
  usage_count: number;
}

export class SqliteEngine {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  index(entries: readonly VaultEntry[]): void {
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO entries
        (id, name, type, source, description, file_path, tags, metadata, content, last_modified, favorite, usage_count)
      VALUES
        (@id, @name, @type, @source, @description, @filePath, @tags, @metadata, @content, @lastModified, @favorite, @usageCount)
    `);

    const existingRows = this.db.prepare('SELECT id FROM entries').all() as Array<{ id: string }>;
    const existingIds = new Set(existingRows.map((r) => r.id));
    const newIds = new Set(entries.map((e) => e.id));

    const deleteStmt = this.db.prepare('DELETE FROM entries WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const id of existingIds) {
        if (!newIds.has(id)) {
          deleteStmt.run(id);
        }
      }

      for (const entry of entries) {
        const existing = this.db.prepare(
          'SELECT favorite, usage_count FROM entries WHERE id = ?'
        ).get(entry.id) as { favorite: number; usage_count: number } | undefined;

        insertStmt.run({
          id: entry.id,
          name: entry.name,
          type: entry.type,
          source: entry.source,
          description: entry.description,
          filePath: entry.filePath,
          tags: entry.tags.join(','),
          metadata: JSON.stringify(entry.metadata),
          content: entry.content.slice(0, 2000),
          lastModified: entry.lastModified.toISOString(),
          favorite: existing?.favorite ?? (entry.favorite ? 1 : 0),
          usageCount: existing?.usage_count ?? entry.usageCount,
        });
      }
    });

    transaction();
  }

  search(options: SearchOptions): SearchResult[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (options.query.trim()) {
      conditions.push('entries.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH @query)');
      params.query = options.query
        .split(/\s+/)
        .map((w) => `"${w}"*`)
        .join(' ');
    }
    if (options.type) {
      conditions.push('type = @type');
      params.type = options.type;
    }
    if (options.source) {
      conditions.push('source = @source');
      params.source = options.source;
    }
    if (options.favoritesOnly) {
      conditions.push('favorite = 1');
    }
    if (options.tags && options.tags.length > 0) {
      for (let i = 0; i < options.tags.length; i++) {
        conditions.push(`tags LIKE @tag${i}`);
        params[`tag${i}`] = `%${options.tags[i]}%`;
      }
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';
    const limit = options.limit ?? 50;

    const sql = `SELECT * FROM entries ${where} ORDER BY usage_count DESC, name ASC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(params) as EntryRow[];

    return rows.map((row, idx) => ({
      entry: this.rowToEntry(row),
      score: 1 - idx / Math.max(rows.length, 1),
      matchedFields: options.query.trim() ? ['name', 'description', 'content'] : [],
    }));
  }

  toggleFavorite(id: string): boolean {
    const row = this.db.prepare('SELECT favorite FROM entries WHERE id = ?').get(id) as { favorite: number } | undefined;
    if (!row) return false;
    const newVal = row.favorite ? 0 : 1;
    this.db.prepare('UPDATE entries SET favorite = ? WHERE id = ?').run(newVal, id);
    return newVal === 1;
  }

  incrementUsage(id: string): void {
    this.db.prepare('UPDATE entries SET usage_count = usage_count + 1 WHERE id = ?').run(id);
  }

  getStats(): VaultStats {
    const totalRow = this.db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    const typeRows = this.db.prepare('SELECT type, COUNT(*) as c FROM entries GROUP BY type').all() as Array<{ type: string; c: number }>;
    const sourceRows = this.db.prepare('SELECT source, COUNT(*) as c FROM entries GROUP BY source').all() as Array<{ source: string; c: number }>;
    const favRow = this.db.prepare('SELECT COUNT(*) as c FROM entries WHERE favorite = 1').get() as { c: number };

    const byType = Object.fromEntries(typeRows.map((r) => [r.type, r.c])) as Record<EntryType, number>;
    const bySource = Object.fromEntries(sourceRows.map((r) => [r.source, r.c]));

    return {
      totalEntries: totalRow.c,
      byType,
      bySource,
      favoriteCount: favRow.c,
      lastScanAt: new Date(),
    };
  }

  getEntry(id: string): VaultEntry | undefined {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
    return row ? this.rowToEntry(row) : undefined;
  }

  close(): void {
    this.db.close();
  }

  private rowToEntry(row: EntryRow): VaultEntry {
    return {
      id: row.id,
      name: row.name,
      type: row.type as VaultEntry['type'],
      source: row.source as VaultEntry['source'],
      description: row.description,
      filePath: row.file_path,
      tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
      metadata: JSON.parse(row.metadata || '{}'),
      content: row.content,
      lastModified: new Date(row.last_modified),
      favorite: row.favorite === 1,
      usageCount: row.usage_count,
    };
  }
}
