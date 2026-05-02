import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Database as SqlJsDatabase } from 'sql.js';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js/dist/sql-asm.js') as (config?: Record<string, unknown>) => Promise<{ Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase }>;
import type {
  VaultEntry,
  SearchResult,
  SearchOptions,
  VaultStats,
  EntryType,
} from '../types/index.js';
import { runMigrations } from './migrations.js';

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

const sanitizeFtsToken = (w: string): string => w.replace(/["*+\-()^{}[\]:]/g, '').trim();

export class SqliteEngine {
  private db: SqlJsDatabase;
  private readonly dbPath: string;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<SqliteEngine> {
    const SQL = await initSqlJs();
    let db: SqlJsDatabase;
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
    db.run('PRAGMA journal_mode = WAL');
    // sql.js db.run() only executes a single statement; use exec() for multi-statement DDL
    db.exec(SCHEMA);
    const engine = new SqliteEngine(db, dbPath);
    runMigrations(db);
    engine.persist();
    return engine;
  }

  /** Run a SELECT and return all matching rows as plain objects. */
  private queryAll<T>(sql: string, params: Record<string, unknown> = {}): T[] {
    const stmt = this.db.prepare(sql);
    if (Object.keys(params).length > 0) {
      stmt.bind(params);
    }
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  /** Run a SELECT and return the first matching row (or undefined). */
  private queryOne<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
    const results = this.queryAll<T>(sql, params);
    return results[0];
  }

  /** Execute a mutation statement (INSERT, UPDATE, DELETE). */
  private execute(sql: string, params: Record<string, unknown> = {}): void {
    this.db.run(sql, params as Record<string, string | number | null | Uint8Array>);
  }

  /** Flush the in-memory database to disk. */
  private persist(): void {
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
  }

  index(entries: readonly VaultEntry[]): void {
    const existingRows = this.queryAll<{ id: string }>('SELECT id FROM entries');
    const existingIds = new Set(existingRows.map((r) => r.id));
    const newIds = new Set(entries.map((e) => e.id));

    this.db.run('BEGIN');
    try {
      for (const id of existingIds) {
        if (!newIds.has(id)) {
          this.execute('DELETE FROM entries WHERE id = $id', { $id: id });
          this.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: id });
        }
      }

      for (const entry of entries) {
        const existing = this.queryOne<{ favorite: number; usage_count: number }>(
          'SELECT favorite, usage_count FROM entries WHERE id = $id',
          { $id: entry.id },
        );

        this.execute(
          `INSERT OR REPLACE INTO entries
            (id, name, type, source, description, file_path, tags, metadata, content, last_modified, favorite, usage_count)
          VALUES
            ($id, $name, $type, $source, $description, $filePath, $tags, $metadata, $content, $lastModified, $favorite, $usageCount)`,
          {
            $id: entry.id,
            $name: entry.name,
            $type: entry.type,
            $source: entry.source,
            $description: entry.description,
            $filePath: entry.filePath,
            $tags: entry.tags.join(','),
            $metadata: JSON.stringify(entry.metadata),
            $content: entry.content,
            $lastModified: entry.lastModified.toISOString(),
            $favorite: existing?.favorite ?? (entry.favorite ? 1 : 0),
            $usageCount: existing?.usage_count ?? entry.usageCount,
          },
        );

        this.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: entry.id });
        for (const tag of entry.tags) {
          if (tag) {
            this.execute(
              'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES ($entryId, $tag)',
              { $entryId: entry.id, $tag: tag },
            );
          }
        }
      }

      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }

    this.persist();
  }

  search(options: SearchOptions): SearchResult[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    const hasTextQuery = (() => {
      if (!options.query.trim()) return false;
      const sanitized = options.query.split(/\s+/).map(sanitizeFtsToken).filter(Boolean);
      if (sanitized.length === 0) return false;
      for (let i = 0; i < sanitized.length; i++) {
        const param = `$q${i}`;
        params[param] = `%${sanitized[i]}%`;
        conditions.push(
          `(name LIKE ${param} OR description LIKE ${param} OR content LIKE ${param} OR tags LIKE ${param})`,
        );
      }
      return true;
    })();

    if (options.type) {
      conditions.push('type = $type');
      params.$type = options.type;
    }
    if (options.source) {
      conditions.push('source = $source');
      params.$source = options.source;
    }
    if (options.favoritesOnly) {
      conditions.push('favorite = 1');
    }
    if (options.tags && options.tags.length > 0) {
      for (let i = 0; i < options.tags.length; i++) {
        const paramName = `$tag${i}`;
        conditions.push(
          `(EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = entries.id AND tag = ${paramName}) OR EXISTS (SELECT 1 FROM user_tags WHERE entry_id = entries.id AND tag = ${paramName}))`,
        );
        params[paramName] = options.tags[i];
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    params.$limit = limit;

    const orderBy = 'ORDER BY usage_count DESC, name ASC';

    const sql = `SELECT * FROM entries ${where} ${orderBy} LIMIT $limit`;
    const rows = this.queryAll<EntryRow>(sql, params);

    return rows.map((row, idx) => ({
      entry: this.rowToEntry(row),
      score: 1 - idx / Math.max(rows.length, 1),
      matchedFields: hasTextQuery ? ['name', 'description', 'content'] : [],
    }));
  }

  toggleFavorite(id: string): boolean {
    const row = this.queryOne<{ favorite: number }>(
      'SELECT favorite FROM entries WHERE id = $id',
      { $id: id },
    );
    if (!row) return false;
    const newVal = row.favorite ? 0 : 1;
    this.execute('UPDATE entries SET favorite = $fav WHERE id = $id', {
      $fav: newVal,
      $id: id,
    });
    this.persist();
    return newVal === 1;
  }

  incrementUsage(id: string): void {
    this.execute(
      'UPDATE entries SET usage_count = usage_count + 1 WHERE id = $id',
      { $id: id },
    );
    this.persist();
  }

  getStats(): VaultStats {
    const totalRow = this.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM entries');
    const typeRows = this.queryAll<{ type: string; c: number }>(
      'SELECT type, COUNT(*) as c FROM entries GROUP BY type',
    );
    const sourceRows = this.queryAll<{ source: string; c: number }>(
      'SELECT source, COUNT(*) as c FROM entries GROUP BY source',
    );
    const favRow = this.queryOne<{ c: number }>(
      'SELECT COUNT(*) as c FROM entries WHERE favorite = 1',
    );

    const byType = Object.fromEntries(typeRows.map((r) => [r.type, r.c])) as Record<
      EntryType,
      number
    >;
    const bySource = Object.fromEntries(sourceRows.map((r) => [r.source, r.c]));

    return {
      totalEntries: totalRow?.c ?? 0,
      byType,
      bySource,
      favoriteCount: favRow?.c ?? 0,
      lastScanAt: new Date(),
    };
  }

  getEntry(id: string): VaultEntry | undefined {
    const row = this.queryOne<EntryRow>(
      'SELECT * FROM entries WHERE id = $id',
      { $id: id },
    );
    if (!row) return undefined;

    const entry = this.rowToEntry(row);
    const userTags = this.getTagsForEntry(id);

    if (userTags.length === 0) return entry;

    const mergedTags = [...new Set([...entry.tags, ...userTags])];
    return { ...entry, tags: mergedTags };
  }

  addTag(entryId: string, tag: string): void {
    this.execute(
      'INSERT OR IGNORE INTO user_tags (entry_id, tag) VALUES ($entryId, $tag)',
      { $entryId: entryId, $tag: tag },
    );
    this.persist();
  }

  removeTag(entryId: string, tag: string): void {
    this.execute(
      'DELETE FROM user_tags WHERE entry_id = $entryId AND tag = $tag',
      { $entryId: entryId, $tag: tag },
    );
    this.persist();
  }

  getTagsForEntry(entryId: string): string[] {
    const rows = this.queryAll<{ tag: string }>(
      'SELECT tag FROM user_tags WHERE entry_id = $entryId',
      { $entryId: entryId },
    );
    return rows.map((r) => r.tag);
  }

  saveSnapshot(entries: readonly VaultEntry[]): void {
    this.db.run('BEGIN');
    try {
      this.execute('DELETE FROM scan_snapshots');
      for (const entry of entries) {
        const hash = createHash('sha256')
          .update(entry.name + entry.type + entry.content)
          .digest('hex');
        this.execute(
          'INSERT INTO scan_snapshots (id, name, type, content_hash) VALUES ($id, $name, $type, $hash)',
          { $id: entry.id, $name: entry.name, $type: entry.type, $hash: hash },
        );
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.persist();
  }

  getDiff(currentEntries: readonly VaultEntry[]): {
    added: VaultEntry[];
    removed: string[];
    modified: VaultEntry[];
  } {
    const snapshotRows = this.queryAll<{
      id: string;
      name: string;
      type: string;
      content_hash: string;
    }>('SELECT * FROM scan_snapshots');

    const snapshotMap = new Map(snapshotRows.map((r) => [r.id, r]));
    const currentMap = new Map(currentEntries.map((e) => [e.id, e]));

    const added: VaultEntry[] = [];
    const removed: string[] = [];
    const modified: VaultEntry[] = [];

    for (const entry of currentEntries) {
      const snapshot = snapshotMap.get(entry.id);
      if (!snapshot) {
        added.push(entry);
      } else {
        const currentHash = createHash('sha256')
          .update(entry.name + entry.type + entry.content)
          .digest('hex');
        if (currentHash !== snapshot.content_hash) {
          modified.push(entry);
        }
      }
    }

    for (const [id, row] of snapshotMap) {
      if (!currentMap.has(id)) {
        removed.push(row.name);
      }
    }

    return { added, removed, modified };
  }

  close(): void {
    this.persist();
    this.db.close();
  }

  private rowToEntry(row: EntryRow): VaultEntry {
    const entryTagRows = this.queryAll<{ tag: string }>(
      'SELECT tag FROM entry_tags WHERE entry_id = $id',
      { $id: row.id },
    );
    const userTagRows = this.queryAll<{ tag: string }>(
      'SELECT tag FROM user_tags WHERE entry_id = $id',
      { $id: row.id },
    );
    const entryTags =
      entryTagRows.length > 0
        ? entryTagRows.map((r) => r.tag)
        : row.tags
          ? row.tags.split(',').filter(Boolean)
          : [];
    const tags = [...new Set([...entryTags, ...userTagRows.map((r) => r.tag)])];

    return {
      id: row.id,
      name: row.name,
      type: row.type as VaultEntry['type'],
      source: row.source as VaultEntry['source'],
      description: row.description,
      filePath: row.file_path,
      tags,
      metadata: JSON.parse(row.metadata || '{}'),
      content: row.content,
      lastModified: new Date(row.last_modified),
      favorite: row.favorite === 1,
      usageCount: row.usage_count,
    };
  }
}
