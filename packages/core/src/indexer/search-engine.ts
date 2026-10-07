import { createHash } from 'node:crypto';
import type {
  VaultEntry,
  SearchResult,
  SearchOptions,
  SearchTier,
  VaultStats,
} from '../types/index.js';
import { FuseEngine } from './fuse-engine.js';
import { MiniSearchEngine } from './minisearch-engine.js';
import { SqliteEngine } from './sqlite-engine.js';
import { normalizeScore } from './normalizer.js';
import { LruCache } from './lru-cache.js';
import { applyUserState } from './user-state.js';

function canonicalCacheKey(options: SearchOptions): string {
  const obj = options as unknown as Record<string, unknown>;
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function entryContentHash(entry: VaultEntry): string {
  return createHash('md5')
    .update(
      `${entry.name}|${entry.description}|${entry.content}|${entry.tags.join(',')}|${entry.lastModified.getTime()}`,
    )
    .digest('hex');
}

export class SearchEngine {
  private fuseEngine: FuseEngine | null = null;
  private miniSearchEngine: MiniSearchEngine | null = null;
  private readonly sqliteEngine: SqliteEngine;
  private readonly defaultTier: SearchTier;
  /** What the last index() was given: the parsers' entries, as the sqlite tier compares them. */
  private scanned: readonly VaultEntry[] = [];
  /** The same entries with the user's marks laid over them (user-state.ts): what readers see. */
  private shown: readonly VaultEntry[] = [];
  private readonly cache = new LruCache<SearchResult[]>(100, 30_000);
  private contentHashes = new Map<string, string>();

  private constructor(sqliteEngine: SqliteEngine, defaultTier: SearchTier) {
    this.sqliteEngine = sqliteEngine;
    this.defaultTier = defaultTier;
  }

  static async create(
    dbPath: string,
    defaultTier: SearchTier = 'minisearch',
  ): Promise<SearchEngine> {
    const sqliteEngine = await SqliteEngine.create(dbPath);
    return new SearchEngine(sqliteEngine, defaultTier);
  }

  /**
   * Whether the sqlite tier answers its next text query with fts5 on this connection; otherwise it
   * answers with LIKE over the same columns and terms, where a term is a substring rather than a
   * token prefix, ranked by its own rule (search-sql.ts). The fuse and minisearch tiers are not
   * affected.
   */
  get supportsFullTextSearch(): boolean {
    return this.sqliteEngine.supportsFullTextSearch;
  }

  /**
   * Brings the database and the tiers to `entries`, the parsers' output, and returns those entries
   * with the favorites, use counts and user tags the rows hold laid over them. The marks are read
   * after the rows are written, so a pruned row leaves none and a mark another process made is
   * current. The sqlite tier and the changeset see `entries` as given: a user tag in what they
   * compare would count as a change to every tagged row on every scan (user-state.ts).
   */
  index(entries: readonly VaultEntry[]): readonly VaultEntry[] {
    this.cache.clear();
    const changedIds = this.computeChangeset(entries);
    this.sqliteEngine.index(entries, changedIds);

    const shown = applyUserState(entries, this.sqliteEngine.readUserState());
    this.scanned = entries;
    this.shown = shown;
    this.fuseEngine?.index(shown);
    this.miniSearchEngine?.index(shown, changedIds);
    return shown;
  }

  /** The entries as the last index() returned them, with every mark recorded through here since. */
  get entries(): readonly VaultEntry[] {
    return this.shown;
  }

  private computeChangeset(entries: readonly VaultEntry[]): ReadonlySet<string> | undefined {
    if (this.contentHashes.size === 0) {
      for (const entry of entries) {
        this.contentHashes.set(entry.id, entryContentHash(entry));
      }
      return undefined;
    }

    const changed = new Set<string>();
    const newHashes = new Map<string, string>();

    for (const entry of entries) {
      const hash = entryContentHash(entry);
      newHashes.set(entry.id, hash);
      if (this.contentHashes.get(entry.id) !== hash) {
        changed.add(entry.id);
      }
    }

    for (const id of this.contentHashes.keys()) {
      if (!newHashes.has(id)) {
        changed.add(id);
      }
    }

    this.contentHashes = newHashes;
    return changed.size > 0 ? changed : undefined;
  }

  search(options: SearchOptions): SearchResult[] {
    const cacheKey = canonicalCacheKey(options);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const tier = options.tier ?? this.defaultTier;
    let rawResults: SearchResult[];

    switch (tier) {
      case 'fuse':
        rawResults = this.getFuse().search(options);
        break;
      case 'minisearch':
        rawResults = this.getMiniSearch().search(options);
        break;
      case 'sqlite':
        rawResults = this.sqliteEngine.search(options);
        break;
    }

    const results = options.query.trim()
      ? normalizeScore(rawResults, options.weights, options.query)
      : rawResults;

    this.cache.set(cacheKey, results);
    return results;
  }

  suggest(query: string, limit?: number): string[] {
    return this.getMiniSearch().suggest(query, limit);
  }

  toggleFavorite(id: string): boolean {
    const favorite = this.sqliteEngine.toggleFavorite(id);
    this.refreshEntry(id);
    return favorite;
  }

  clearCache(): void {
    this.cache.clear();
  }

  incrementUsage(id: string): void {
    this.sqliteEngine.incrementUsage(id);
    this.refreshEntry(id);
  }

  getStats(): VaultStats {
    return this.sqliteEngine.getStats();
  }

  getEntry(id: string): VaultEntry | undefined {
    return this.sqliteEngine.getEntry(id);
  }

  addTag(entryId: string, tag: string): void {
    this.sqliteEngine.addTag(entryId, tag);
    this.refreshEntry(entryId);
  }

  removeTag(entryId: string, tag: string): void {
    this.sqliteEngine.removeTag(entryId, tag);
    this.refreshEntry(entryId);
  }

  getTagsForEntry(entryId: string): string[] {
    return this.sqliteEngine.getTagsForEntry(entryId);
  }

  saveSnapshot(entries: readonly VaultEntry[]): void {
    this.sqliteEngine.saveSnapshot(entries);
  }

  getDiff(currentEntries: readonly VaultEntry[]): {
    added: VaultEntry[];
    removed: string[];
    modified: VaultEntry[];
  } {
    return this.sqliteEngine.getDiff(currentEntries);
  }

  close(): void {
    this.sqliteEngine.close();
  }

  /**
   * After a mark on one entry: lays the marks its row holds now over the scanned entry again (a
   * user tag removed stays when it is a parser tag too) and puts the result where the readers look.
   * Fuse has no per-document update, so it is dropped and built again from `shown` when next
   * searched: an eager rebuild per mark would make a bulk toggle quadratic. MiniSearch re-adds the
   * document only when its text changed and replaces its entry map either way, so its filters see
   * the new favorite and tags.
   */
  private refreshEntry(id: string): void {
    this.cache.clear();
    const scanned = this.scanned.find((entry) => entry.id === id);
    if (!scanned) return;

    const fresh = applyUserState([scanned], this.sqliteEngine.readUserState([id]))[0] ?? scanned;
    this.shown = this.shown.map((entry) => (entry.id === id ? fresh : entry));
    this.fuseEngine = null;
    this.miniSearchEngine?.index(this.shown, new Set([id]));
  }

  private getFuse(): FuseEngine {
    if (!this.fuseEngine) {
      // Assign only after index() succeeds: a failed build must not be kept and served half-built.
      const engine = new FuseEngine();
      engine.index(this.shown);
      this.fuseEngine = engine;
    }
    return this.fuseEngine;
  }

  private getMiniSearch(): MiniSearchEngine {
    if (!this.miniSearchEngine) {
      // Assign only after index() succeeds: MiniSearch throws on a duplicate id partway through,
      // and keeping that engine would silently answer later queries from a partial index.
      const engine = new MiniSearchEngine();
      engine.index(this.shown);
      this.miniSearchEngine = engine;
    }
    return this.miniSearchEngine;
  }
}
