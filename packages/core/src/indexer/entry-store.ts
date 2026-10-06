import type { VaultEntry, SearchResult, SearchOptions } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';
import { readEngineMeta } from './migrations.js';

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

/** The columns a scan owns. `favorite` and `usage_count` are the user's: never written back. */
const SCANNED_COLUMNS = [
  'name',
  'type',
  'source',
  'description',
  'file_path',
  'tags',
  'metadata',
  'content',
  'last_modified',
] as const;

type ScannedColumn = (typeof SCANNED_COLUMNS)[number];
type ScannedValues = Readonly<Record<ScannedColumn, string>>;
type ScannedRow = ScannedValues & { readonly id: string };

/** Ids per `IN (...)` list, well under SQLite's historical limit of 999 bound variables. */
const ID_LIST_CHUNK = 500;

/**
 * Inserts a new row with the state the entry carries, updates the scanned columns of an existing row
 * only when one differs, and returns the id in both cases and nothing otherwise: an unchanged row
 * is not written (no WAL growth, no `data_version` bump, nothing to redo in tags or full text).
 */
const UPSERT_ENTRY = `
  INSERT INTO entries (id, ${SCANNED_COLUMNS.join(', ')}, favorite, usage_count)
  VALUES ($id, ${SCANNED_COLUMNS.map((column) => `$${column}`).join(', ')}, $favorite, $usage_count)
  ON CONFLICT(id) DO UPDATE SET
    ${SCANNED_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')}
  WHERE ${SCANNED_COLUMNS.map((column) => `entries.${column} IS NOT excluded.${column}`).join(' OR ')}
  RETURNING id`;

const SELECT_SCANNED = `SELECT id, ${SCANNED_COLUMNS.join(', ')} FROM entries`;

/** Rows that carry tags but have no `entry_tags` rows (see restoreMissingEntryTags). */
const SELECT_MISSING_ENTRY_TAGS = `
  SELECT id, tags FROM entries e
  WHERE tags != '' AND NOT EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = e.id)`;

/** The scanned columns exactly as the upsert binds them. */
function scannedValues(entry: VaultEntry): ScannedValues {
  return {
    name: entry.name,
    type: entry.type,
    source: entry.source,
    description: entry.description,
    file_path: entry.filePath,
    tags: entry.tags.join(','),
    metadata: JSON.stringify(entry.metadata),
    content: entry.content,
    last_modified: entry.lastModified.toISOString(),
  };
}

function isStoredAs(row: ScannedRow | undefined, values: ScannedValues): boolean {
  return row !== undefined && SCANNED_COLUMNS.every((column) => row[column] === values[column]);
}

function splitTags(tags: string): string[] {
  return tags.split(',').filter(Boolean);
}

/** `IN (...)` lists of at most ID_LIST_CHUNK ids each (`$i0, $i1, ...`), with their bindings. */
function idLists(ids: readonly string[]): Array<{ list: string; params: Record<string, unknown> }> {
  const lists = [];
  for (let start = 0; start < ids.length; start += ID_LIST_CHUNK) {
    const chunk = ids.slice(start, start + ID_LIST_CHUNK);
    const params = Object.fromEntries(chunk.map((id, index) => [`$i${index}`, id]));
    lists.push({ list: Object.keys(params).join(', '), params });
  }
  return lists;
}

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

  /**
   * Brings `entries` (the whole scan) into the database in one write transaction that takes the
   * lock when it starts: rows the scan no longer produces go, changed rows are updated, new rows
   * inserted, and `entry_tags` and the full-text table follow the rows actually written. Nothing
   * read before the transaction is written back inside it, so a favorite or a use another process
   * records meanwhile is kept. `changedIds` only narrows which entries are offered to the upsert.
   * A scan with nothing to change takes no write lock at all: commands that only read stay readers.
   */
  index(entries: readonly VaultEntry[], changedIds?: ReadonlySet<string>): void {
    const offered = changedIds ? entries.filter((entry) => changedIds.has(entry.id)) : entries;
    const scannedIds = new Set(entries.map((entry) => entry.id));
    this.invalidateTagCache();
    if (!this.hasWork(offered, scannedIds)) return;

    this.conn.transaction(
      () => {
        const ftsReady = readEngineMeta(this.conn).get('fts_state') === 'ready';
        const prunedIds = this.pruneEntriesNotIn(scannedIds);
        const writtenIds = offered.filter((entry) => this.upsertEntry(entry)).map(({ id }) => id);
        this.restoreMissingEntryTags();
        if (ftsReady) this.maintainFts(writtenIds, prunedIds);
      },
      { mode: 'immediate' },
    );
  }

  /**
   * Whether the scan has anything to write, read from the scanned columns alone: a row to prune, a
   * row missing or different, or tags with no `entry_tags`. The user's columns are not read, and
   * nothing read here is written back: the upsert's WHERE decides again under the lock.
   */
  private hasWork(offered: readonly VaultEntry[], scannedIds: ReadonlySet<string>): boolean {
    const stored = new Map(
      this.conn.queryAll<ScannedRow>(SELECT_SCANNED).map((row) => [row.id, row]),
    );
    if ([...stored.keys()].some((id) => !scannedIds.has(id))) return true;
    if (offered.some((entry) => !isStoredAs(stored.get(entry.id), scannedValues(entry))))
      return true;
    return this.conn.queryOne(`${SELECT_MISSING_ENTRY_TAGS} LIMIT 1`) !== undefined;
  }

  /** Today's rule: every row whose id the scan did not produce goes (its full-text row with it). */
  private pruneEntriesNotIn(scannedIds: ReadonlySet<string>): string[] {
    const stored = this.conn.queryAll<{ id: string }>('SELECT id FROM entries');
    const pruned = stored.map(({ id }) => id).filter((id) => !scannedIds.has(id));
    for (const id of pruned) {
      this.conn.execute('DELETE FROM entries WHERE id = $id', { $id: id });
      this.conn.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: id });
    }
    return pruned;
  }

  /** Writes the row when it is new or changed, and then its tags too; returns whether it did. */
  private upsertEntry(entry: VaultEntry): boolean {
    const values = scannedValues(entry);
    const written = this.conn.queryAll<{ id: string }>(UPSERT_ENTRY, {
      ...Object.fromEntries(SCANNED_COLUMNS.map((column) => [`$${column}`, values[column]])),
      $id: entry.id,
      $favorite: entry.favorite ? 1 : 0,
      $usage_count: entry.usageCount,
    });
    if (written.length === 0) return false;

    this.conn.execute('DELETE FROM entry_tags WHERE entry_id = $id', { $id: entry.id });
    this.insertEntryTags(entry.id, entry.tags);
    return true;
  }

  private insertEntryTags(entryId: string, tags: readonly string[]): void {
    for (const tag of tags.filter(Boolean)) {
      this.conn.execute(
        'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES ($entryId, $tag)',
        {
          $entryId: entryId,
          $tag: tag,
        },
      );
    }
  }

  /**
   * Rows that carry tags but have no `entry_tags` (a database from before migration 1, or one whose
   * table was lost) used to get them back from the rewrite of every row on every scan; now that an
   * unchanged row is not written, this query does. Normally finds nothing.
   */
  private restoreMissingEntryTags(): void {
    const rows = this.conn.queryAll<{ id: string; tags: string }>(SELECT_MISSING_ENTRY_TAGS);
    for (const row of rows) this.insertEntryTags(row.id, splitTags(row.tags));
  }

  /**
   * Replaces the full-text rows of the rows this transaction wrote and deletes those of the pruned
   * ones, inside the transaction, so a reader in another process never sees the table empty. The id
   * column is not indexed and every DELETE scans the table once: id lists keep that to a few scans.
   */
  private maintainFts(writtenIds: readonly string[], prunedIds: readonly string[]): void {
    for (const { list, params } of idLists([...writtenIds, ...prunedIds])) {
      this.conn.execute(`DELETE FROM entries_fts WHERE id IN (${list})`, params);
    }
    for (const { list, params } of idLists(writtenIds)) {
      this.conn.execute(
        `INSERT INTO entries_fts(id, name, description, content, tags)
         SELECT id, name, description, content, tags FROM entries WHERE id IN (${list})`,
        params,
      );
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

  /**
   * One statement flips and reads back the value, so two processes toggling at once each see their
   * own flip. The transaction is what makes the pure-JavaScript backend save a write that goes
   * through a query, which a RETURNING statement is. Unknown id: false.
   */
  toggleFavorite(id: string): boolean {
    const row = this.conn.transaction(
      () =>
        this.conn.queryOne<{ favorite: number }>(
          'UPDATE entries SET favorite = 1 - favorite WHERE id = $id RETURNING favorite',
          { $id: id },
        ),
      { mode: 'immediate' },
    );
    return row?.favorite === 1;
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
