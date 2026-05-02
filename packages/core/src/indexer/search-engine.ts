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

export class SearchEngine {
  private fuseEngine: FuseEngine | null = null;
  private miniSearchEngine: MiniSearchEngine | null = null;
  private readonly sqliteEngine: SqliteEngine;
  private readonly defaultTier: SearchTier;
  private pendingEntries: readonly VaultEntry[] = [];
  private readonly cache = new LruCache<SearchResult[]>(100, 30_000);

  private constructor(sqliteEngine: SqliteEngine, defaultTier: SearchTier) {
    this.sqliteEngine = sqliteEngine;
    this.defaultTier = defaultTier;
  }

  static async create(dbPath: string, defaultTier: SearchTier = 'minisearch'): Promise<SearchEngine> {
    const sqliteEngine = await SqliteEngine.create(dbPath);
    return new SearchEngine(sqliteEngine, defaultTier);
  }

  index(entries: readonly VaultEntry[]): void {
    this.pendingEntries = entries;
    this.cache.clear();

    this.sqliteEngine.index(entries);

    if (this.fuseEngine) {
      this.fuseEngine.index(entries);
    }
    if (this.miniSearchEngine) {
      this.miniSearchEngine.index(entries);
    }
  }

  search(options: SearchOptions): SearchResult[] {
    const cacheKey = JSON.stringify(options);
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
    this.cache.clear();
    return this.sqliteEngine.toggleFavorite(id);
  }

  incrementUsage(id: string): void {
    this.sqliteEngine.incrementUsage(id);
  }

  getStats(): VaultStats {
    return this.sqliteEngine.getStats();
  }

  getEntry(id: string): VaultEntry | undefined {
    return this.sqliteEngine.getEntry(id);
  }

  addTag(entryId: string, tag: string): void {
    this.sqliteEngine.addTag(entryId, tag);
  }

  removeTag(entryId: string, tag: string): void {
    this.sqliteEngine.removeTag(entryId, tag);
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

  private getFuse(): FuseEngine {
    if (!this.fuseEngine) {
      this.fuseEngine = new FuseEngine();
      this.fuseEngine.index(this.pendingEntries);
    }
    return this.fuseEngine;
  }

  private getMiniSearch(): MiniSearchEngine {
    if (!this.miniSearchEngine) {
      this.miniSearchEngine = new MiniSearchEngine();
      this.miniSearchEngine.index(this.pendingEntries);
    }
    return this.miniSearchEngine;
  }
}
