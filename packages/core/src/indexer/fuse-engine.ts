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

export class FuseEngine {
  private fuse: Fuse<VaultEntry>;
  private entries: VaultEntry[];

  constructor() {
    this.entries = [];
    this.fuse = new Fuse([] as VaultEntry[], FUSE_OPTIONS);
  }

  index(entries: readonly VaultEntry[]): void {
    this.entries = [...entries];
    this.fuse = new Fuse(this.entries as VaultEntry[], FUSE_OPTIONS);
  }

  search(options: SearchOptions): SearchResult[] {
    const preFiltered = this.applyFilters(this.entries, options);

    if (!options.query.trim()) {
      return preFiltered
        .slice(0, options.limit ?? 50)
        .map((entry) => ({ entry, score: 1, matchedFields: [] }));
    }

    const filteredFuse = new Fuse(preFiltered, FUSE_OPTIONS);
    const results = filteredFuse.search(options.query);

    return results.slice(0, options.limit ?? 50).map((r) => ({
      entry: r.item,
      score: 1 - (r.score ?? 0),
      matchedFields: r.matches?.map((m) => m.key ?? '') ?? [],
    }));
  }

  private applyFilters(
    entries: readonly VaultEntry[],
    options: SearchOptions
  ): VaultEntry[] {
    let filtered = [...entries];

    if (options.type) {
      filtered = filtered.filter((e) => e.type === options.type);
    }
    if (options.source) {
      filtered = filtered.filter((e) => e.source === options.source);
    }
    if (options.tags && options.tags.length > 0) {
      filtered = filtered.filter((e) =>
        options.tags!.every((t) => e.tags.includes(t))
      );
    }
    if (options.favoritesOnly) {
      filtered = filtered.filter((e) => e.favorite);
    }

    return filtered;
  }
}
