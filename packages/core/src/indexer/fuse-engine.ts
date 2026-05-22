import Fuse, { type IFuseOptions } from 'fuse.js';
import type { VaultEntry, SearchResult, SearchOptions } from '../types/index.js';
import { matchesFilters, applyFilters } from './filter-utils.js';
import { parseQuery, applyQueryFilters } from './query-parser.js';

/** Maximum content length indexed by Fuse to avoid bloating the in-memory index. */
const CONTENT_TRUNCATE_LENGTH = 500;

interface TruncatedEntry extends VaultEntry {
  readonly content: string;
}

const FUSE_OPTIONS: IFuseOptions<TruncatedEntry> = {
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

export class FuseEngine {
  private fuse: Fuse<TruncatedEntry>;
  private entries: TruncatedEntry[];
  private filterCache: Map<string, Fuse<TruncatedEntry>> = new Map();

  constructor() {
    this.entries = [];
    this.fuse = new Fuse([] as TruncatedEntry[], FUSE_OPTIONS);
  }

  index(entries: readonly VaultEntry[]): void {
    this.entries = entries.map((e) => ({
      ...e,
      content: e.content.slice(0, CONTENT_TRUNCATE_LENGTH),
    }));
    this.fuse = new Fuse(this.entries, FUSE_OPTIONS);
    this.filterCache.clear();
  }

  search(options: SearchOptions): SearchResult[] {
    const parsed = parseQuery(options.query);

    // Merge inline filters from query operators into search options
    const mergedOptions: SearchOptions = {
      ...options,
      ...(parsed.filters.type ? { type: parsed.filters.type as SearchOptions['type'] } : {}),
      ...(parsed.filters.source
        ? { source: parsed.filters.source as SearchOptions['source'] }
        : {}),
      ...(parsed.filters.tags ? { tags: parsed.filters.tags } : {}),
    };

    const hasFilters =
      mergedOptions.type ||
      mergedOptions.source ||
      mergedOptions.tags?.length ||
      mergedOptions.favoritesOnly ||
      mergedOptions.modifiedAfter ||
      mergedOptions.modifiedBefore;
    const offset = mergedOptions.offset ?? 0;
    const limit = mergedOptions.limit ?? 50;

    const fuzzyQuery = parsed.terms.join(' ');

    if (!fuzzyQuery) {
      const filtered = hasFilters ? applyFilters(this.entries, mergedOptions) : this.entries;
      const postFiltered = applyQueryFilters(filtered, parsed);
      return postFiltered
        .slice(offset, offset + limit)
        .map((entry) => ({ entry, score: 1, matchedFields: [] }));
    }

    const fuseInstance = hasFilters ? this.getFilteredFuse(mergedOptions) : this.fuse;
    const results = fuseInstance.search(fuzzyQuery);

    const postFiltered = applyQueryFilters(
      results.map((r) => r.item),
      parsed,
    );
    const postFilteredIds = new Set(postFiltered.map((e) => e.id));

    return results
      .filter((r) => postFilteredIds.has(r.item.id))
      .slice(offset, offset + limit)
      .map((r) => ({
        entry: r.item,
        score: 1 - (r.score ?? 0),
        matchedFields: r.matches?.map((m) => m.key ?? '') ?? [],
      }));
  }

  private getFilteredFuse(options: SearchOptions): Fuse<TruncatedEntry> {
    const key = buildFilterKey(options);
    const cached = this.filterCache.get(key);
    if (cached) return cached;

    if (this.filterCache.size >= MAX_FILTER_CACHE) {
      const oldest = this.filterCache.keys().next().value!;
      this.filterCache.delete(oldest);
    }

    const filtered = applyFilters(this.entries, options);
    const instance = new Fuse(filtered, FUSE_OPTIONS);
    this.filterCache.set(key, instance);
    return instance;
  }
}
