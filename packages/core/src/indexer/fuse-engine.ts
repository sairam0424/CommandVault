import Fuse, { type IFuseOptions } from 'fuse.js';
import type { VaultEntry, SearchResult, SearchOptions } from '../types/index.js';

const FUSE_OPTIONS: IFuseOptions<VaultEntry> = {
  keys: [
    { name: 'name', weight: 3 },
    { name: 'description', weight: 2 },
    { name: 'tags', weight: 1.5 },
    { name: 'source', weight: 0.5 },
    { name: 'content', weight: 0.3 },
  ],
  threshold: 0.4,
  includeScore: true,
  includeMatches: true,
  minMatchCharLength: 2,
};

const MAX_FILTER_CACHE = 20;

function buildFilterKey(options: SearchOptions): string {
  return JSON.stringify({
    t: options.type ?? null,
    s: options.source ?? null,
    g: options.tags ?? null,
    f: options.favoritesOnly ?? false,
    ma: options.modifiedAfter?.toISOString() ?? null,
    mb: options.modifiedBefore?.toISOString() ?? null,
  });
}

function matchesDateRange(entry: VaultEntry, options: SearchOptions): boolean {
  if (options.modifiedAfter && entry.lastModified < options.modifiedAfter) return false;
  if (options.modifiedBefore && entry.lastModified > options.modifiedBefore) return false;
  return true;
}

export class FuseEngine {
  private fuse: Fuse<VaultEntry>;
  private entries: VaultEntry[];
  private filterCache: Map<string, Fuse<VaultEntry>> = new Map();

  constructor() {
    this.entries = [];
    this.fuse = new Fuse([] as VaultEntry[], FUSE_OPTIONS);
  }

  index(entries: readonly VaultEntry[]): void {
    this.entries = [...entries];
    this.fuse = new Fuse(this.entries as VaultEntry[], FUSE_OPTIONS);
    this.filterCache.clear();
  }

  search(options: SearchOptions): SearchResult[] {
    const hasFilters =
      options.type ||
      options.source ||
      options.tags?.length ||
      options.favoritesOnly ||
      options.modifiedAfter ||
      options.modifiedBefore;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;

    if (!options.query.trim()) {
      const filtered = hasFilters ? this.applyFilters(this.entries, options) : this.entries;
      return filtered
        .slice(offset, offset + limit)
        .map((entry) => ({ entry, score: 1, matchedFields: [] }));
    }

    const fuseInstance = hasFilters ? this.getFilteredFuse(options) : this.fuse;
    const results = fuseInstance.search(options.query);

    return results.slice(offset, offset + limit).map((r) => ({
      entry: r.item,
      score: 1 - (r.score ?? 0),
      matchedFields: r.matches?.map((m) => m.key ?? '') ?? [],
    }));
  }

  private getFilteredFuse(options: SearchOptions): Fuse<VaultEntry> {
    const key = buildFilterKey(options);
    const cached = this.filterCache.get(key);
    if (cached) return cached;

    if (this.filterCache.size >= MAX_FILTER_CACHE) {
      const oldest = this.filterCache.keys().next().value!;
      this.filterCache.delete(oldest);
    }

    const filtered = this.applyFilters(this.entries, options);
    const instance = new Fuse(filtered, FUSE_OPTIONS);
    this.filterCache.set(key, instance);
    return instance;
  }

  private applyFilters(entries: readonly VaultEntry[], options: SearchOptions): VaultEntry[] {
    let filtered = [...entries];

    if (options.type) {
      filtered = filtered.filter((e) => e.type === options.type);
    }
    if (options.source) {
      filtered = filtered.filter((e) => e.source === options.source);
    }
    if (options.tags && options.tags.length > 0) {
      filtered = filtered.filter((e) => options.tags!.every((t) => e.tags.includes(t)));
    }
    if (options.favoritesOnly) {
      filtered = filtered.filter((e) => e.favorite);
    }
    if (options.modifiedAfter || options.modifiedBefore) {
      filtered = filtered.filter((e) => matchesDateRange(e, options));
    }

    return filtered;
  }
}
