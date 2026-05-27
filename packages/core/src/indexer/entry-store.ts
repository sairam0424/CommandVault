import type { VaultEntry, SearchResult, SearchOptions } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';

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

function rowToEntry(
  row: EntryRow,
  entryTagMap: ReadonlyMap<string, readonly string[]>,
  userTagMap: ReadonlyMap<string, readonly string[]>,
): VaultEntry {
  const entryTags = entryTagMap.get(row.id);
  const resolvedEntryTags =
    entryTags && entryTags.length > 0
      ? [...entryTags]
      : row.tags
        ? row.tags.split(',').filter(Boolean)
        : [];
  const userTags = userTagMap.get(row.id) ?? [];
  const tags = [...new Set([...resolvedEntryTags, ...userTags])];

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

function buildTagMaps(conn: DatabaseAdapter): {
  entryTagMap: Map<string, string[]>;
  userTagMap: Map<string, string[]>;
} {
  const entryTagRows = conn.queryAll<{ entry_id: string; tag: string }>(
    'SELECT entry_id, tag FROM entry_tags',
  );
  const userTagRows = conn.queryAll<{ entry_id: string; tag: string }>(
    'SELECT entry_id, tag FROM user_tags',
  );

  const entryTagMap = new Map<string, string[]>();
  for (const row of entryTagRows) {
    const existing = entryTagMap.get(row.entry_id) ?? [];
    entryTagMap.set(row.entry_id, [...existing, row.tag]);
  }

  const userTagMap = new Map<string, string[]>();
  for (const row of userTagRows) {
    const existing = userTagMap.get(row.entry_id) ?? [];
    userTagMap.set(row.entry_id, [...existing, row.tag]);
  }

  return { entryTagMap, userTagMap };
}

export class EntryStore {
  private readonly conn: DatabaseAdapter;
  private tagMapCache: {
    entryTagMap: Map<string, string[]>;
    userTagMap: Map<string, string[]>;
  } | null = null;

  constructor(conn: DatabaseAdapter) {
    this.conn = conn;
  }

  /** Invalidate the cached tag maps. Call after any tag mutation or re-index. */
  invalidateTagCache(): void {
    this.tagMapCache = null;
  }

  private getTagMaps(): { entryTagMap: Map<string, string[]>; userTagMap: Map<string, string[]> } {
    if (this.tagMapCache === null) {
      this.tagMapCache = buildTagMaps(this.conn);
    }
    return this.tagMapCache;
  }

  index(entries: readonly VaultEntry[], changedIds?: ReadonlySet<string>): void {
    const existingRows = this.conn.queryAll<{ id: string; favorite: number; usage_count: number }>(
      'SELECT id, favorite, usage_count FROM entries',
    );
    const existingMap = new Map(existingRows.map((r) => [r.id, r]));
    const existingIds = new Set(existingMap.keys());
    const newIds = new Set(entries.map((e) => e.id));

    const entriesToUpsert = changedIds ? entries.filter((e) => changedIds.has(e.id)) : entries;

    this.conn.transaction(() => {
      for (const id of existingIds) {
        if (!newIds.has(id)) {
          this.conn.execute('DELETE FROM entries WHERE id = $id', { $id: id });
          this.conn.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: id });
        }
      }

      for (const entry of entriesToUpsert) {
        const existing = existingMap.get(entry.id);

        this.conn.execute(
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

        this.conn.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: entry.id });
        for (const tag of entry.tags) {
          if (tag) {
            this.conn.execute(
              'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES ($entryId, $tag)',
              { $entryId: entry.id, $tag: tag },
            );
          }
        }
      }
    });

    this.invalidateTagCache();
    this.rebuildFts(changedIds);
  }

  private rebuildFts(changedIds?: ReadonlySet<string>): void {
    try {
      if (!changedIds) {
        this.conn.execute('DELETE FROM entries_fts');
        this.conn.execute(`
          INSERT INTO entries_fts(id, name, description, content, tags)
          SELECT id, name, description, content, tags FROM entries
        `);
      } else {
        for (const id of changedIds) {
          this.conn.execute('DELETE FROM entries_fts WHERE id = $id', { $id: id });
          this.conn.execute(
            `INSERT OR IGNORE INTO entries_fts(id, name, description, content, tags)
             SELECT id, name, description, content, tags FROM entries WHERE id = $id`,
            { $id: id },
          );
        }
      }
    } catch {
      // FTS5 table may not exist yet (pre-migration)
    }
  }

  search(options: SearchOptions): SearchResult[] {
    const queryText = options.query.trim();
    const hasTextQuery = queryText.length > 0;

    // Attempt FTS5 search when a text query is present
    if (hasTextQuery) {
      try {
        return this.searchFts(options, queryText);
      } catch {
        // FTS5 MATCH failed (malformed query or table missing) — fall back to LIKE
      }
    }

    return this.searchLike(options);
  }

  /** FTS5-based search using MATCH for full-text relevance ranking. */
  private searchFts(options: SearchOptions, queryText: string): SearchResult[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    // Build FTS5 match expression: sanitize each word and join with AND
    const sanitized = queryText.split(/\s+/).map(sanitizeFtsToken).filter(Boolean);
    if (sanitized.length === 0) {
      return this.searchLike(options);
    }
    // Use prefix matching with * for better partial-word matches
    const ftsQuery = sanitized.map((w) => `"${w}"*`).join(' AND ');
    params.$ftsQuery = ftsQuery;

    // Apply non-text filters on the entries table
    if (options.type) {
      conditions.push('e.type = $type');
      params.$type = options.type;
    }
    if (options.source) {
      conditions.push('e.source = $source');
      params.$source = options.source;
    }
    if (options.favoritesOnly) {
      conditions.push('e.favorite = 1');
    }
    if (options.tags && options.tags.length > 0) {
      for (let i = 0; i < options.tags.length; i++) {
        const paramName = `$tag${i}`;
        conditions.push(
          `(EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = e.id AND tag = ${paramName}) OR EXISTS (SELECT 1 FROM user_tags WHERE entry_id = e.id AND tag = ${paramName}))`,
        );
        params[paramName] = options.tags[i];
      }
    }
    if (options.modifiedAfter) {
      conditions.push('e.last_modified >= $modifiedAfter');
      params.$modifiedAfter = options.modifiedAfter.toISOString();
    }
    if (options.modifiedBefore) {
      conditions.push('e.last_modified <= $modifiedBefore');
      params.$modifiedBefore = options.modifiedBefore.toISOString();
    }

    const filterClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    params.$limit = limit;

    const offsetClause = options.offset ? 'OFFSET $offset' : '';
    if (options.offset) {
      params.$offset = options.offset;
    }

    const sql = `
      SELECT e.* FROM entries e
      JOIN entries_fts f ON e.id = f.id
      WHERE entries_fts MATCH $ftsQuery ${filterClause}
      ORDER BY f.rank, e.usage_count DESC, e.name ASC
      LIMIT $limit ${offsetClause}
    `;

    const rows = this.conn.queryAll<EntryRow>(sql, params);
    const { entryTagMap, userTagMap } = this.getTagMaps();

    return rows.map((row, idx) => ({
      entry: rowToEntry(row, entryTagMap, userTagMap),
      score: 1 - idx / Math.max(rows.length, 1),
      matchedFields: ['name', 'description', 'content'],
    }));
  }

  /** Fallback LIKE-based search for when FTS5 is unavailable or query is malformed. */
  private searchLike(options: SearchOptions): SearchResult[] {
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
    if (options.modifiedAfter) {
      conditions.push(`last_modified >= $modifiedAfter`);
      params.$modifiedAfter = options.modifiedAfter.toISOString();
    }
    if (options.modifiedBefore) {
      conditions.push(`last_modified <= $modifiedBefore`);
      params.$modifiedBefore = options.modifiedBefore.toISOString();
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    params.$limit = limit;

    const orderBy = 'ORDER BY usage_count DESC, name ASC';
    const offsetClause = options.offset ? `OFFSET $offset` : '';
    if (options.offset) {
      params.$offset = options.offset;
    }

    const sql = `SELECT * FROM entries ${where} ${orderBy} LIMIT $limit ${offsetClause}`;
    const rows = this.conn.queryAll<EntryRow>(sql, params);

    const { entryTagMap, userTagMap } = this.getTagMaps();

    return rows.map((row, idx) => ({
      entry: rowToEntry(row, entryTagMap, userTagMap),
      score: 1 - idx / Math.max(rows.length, 1),
      matchedFields: hasTextQuery ? ['name', 'description', 'content'] : [],
    }));
  }

  toggleFavorite(id: string): boolean {
    const row = this.conn.queryOne<{ favorite: number }>(
      'SELECT favorite FROM entries WHERE id = $id',
      { $id: id },
    );
    if (!row) return false;
    const newVal = row.favorite ? 0 : 1;
    this.conn.execute('UPDATE entries SET favorite = $fav WHERE id = $id', {
      $fav: newVal,
      $id: id,
    });
    return newVal === 1;
  }

  incrementUsage(id: string): void {
    this.conn.execute('UPDATE entries SET usage_count = usage_count + 1 WHERE id = $id', {
      $id: id,
    });
  }

  getEntry(id: string): VaultEntry | undefined {
    const row = this.conn.queryOne<EntryRow>('SELECT * FROM entries WHERE id = $id', { $id: id });
    if (!row) return undefined;

    const entryTagRows = this.conn.queryAll<{ entry_id: string; tag: string }>(
      'SELECT entry_id, tag FROM entry_tags WHERE entry_id = $id',
      { $id: id },
    );
    const userTagRows = this.conn.queryAll<{ entry_id: string; tag: string }>(
      'SELECT entry_id, tag FROM user_tags WHERE entry_id = $id',
      { $id: id },
    );

    const entryTagMap = new Map<string, string[]>();
    for (const r of entryTagRows) {
      const existing = entryTagMap.get(r.entry_id) ?? [];
      entryTagMap.set(r.entry_id, [...existing, r.tag]);
    }

    const userTagMap = new Map<string, string[]>();
    for (const r of userTagRows) {
      const existing = userTagMap.get(r.entry_id) ?? [];
      userTagMap.set(r.entry_id, [...existing, r.tag]);
    }

    return rowToEntry(row, entryTagMap, userTagMap);
  }

  getEntries(): VaultEntry[] {
    const rows = this.conn.queryAll<EntryRow>('SELECT * FROM entries');
    const { entryTagMap, userTagMap } = this.getTagMaps();
    return rows.map((row) => rowToEntry(row, entryTagMap, userTagMap));
  }
}
