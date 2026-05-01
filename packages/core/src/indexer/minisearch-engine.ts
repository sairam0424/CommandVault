import MiniSearch from 'minisearch';
import type { VaultEntry, SearchResult, SearchOptions } from '../types/index.js';

const FIELDS = ['name', 'description', 'tags', 'source', 'type', 'content'];
const STORED_FIELDS = ['id'];
const BOOST = { name: 3, description: 2, tags: 1.5, source: 0.5, type: 0.5, content: 0.3 };

export class MiniSearchEngine {
  private engine: MiniSearch;
  private entriesById: Map<string, VaultEntry>;

  constructor() {
    this.engine = new MiniSearch({
      fields: FIELDS,
      storeFields: STORED_FIELDS,
      searchOptions: {
        boost: BOOST,
        prefix: true,
        fuzzy: 0.2,
      },
    });
    this.entriesById = new Map();
  }

  index(entries: readonly VaultEntry[]): void {
    this.entriesById = new Map(entries.map((e) => [e.id, e]));
    this.engine = new MiniSearch({
      fields: FIELDS,
      storeFields: STORED_FIELDS,
      searchOptions: {
        boost: BOOST,
        prefix: true,
        fuzzy: 0.2,
      },
    });

    const docs = entries.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      tags: e.tags.join(' '),
      source: e.source,
      type: e.type,
      content: e.content.slice(0, 500),
    }));

    this.engine.addAll(docs);
  }

  search(options: SearchOptions): SearchResult[] {
    const allEntries = [...this.entriesById.values()];

    if (!options.query.trim()) {
      const filtered = this.applyFilters(allEntries, options);
      return filtered
        .slice(0, options.limit ?? 50)
        .map((entry) => ({ entry, score: 1, matchedFields: [] }));
    }

    const rawResults = this.engine.search(options.query, {
      boost: BOOST,
      prefix: true,
      fuzzy: 0.2,
    });

    const maxScore = rawResults.length > 0 ? Math.max(...rawResults.map((r) => r.score)) : 1;

    const results: SearchResult[] = [];
    for (const raw of rawResults) {
      const entry = this.entriesById.get(raw.id as string);
      if (!entry) continue;
      if (!this.matchesFilters(entry, options)) continue;

      results.push({
        entry,
        score: raw.score / maxScore,
        matchedFields: Object.keys(raw.match),
      });
    }

    return results.slice(0, options.limit ?? 50);
  }

  suggest(query: string, limit = 10): string[] {
    return this.engine
      .autoSuggest(query, { boost: BOOST })
      .slice(0, limit)
      .map((s) => s.suggestion);
  }

  private applyFilters(entries: VaultEntry[], options: SearchOptions): VaultEntry[] {
    return entries.filter((e) => this.matchesFilters(e, options));
  }

  private matchesFilters(entry: VaultEntry, options: SearchOptions): boolean {
    if (options.type && entry.type !== options.type) return false;
    if (options.source && entry.source !== options.source) return false;
    if (options.favoritesOnly && !entry.favorite) return false;
    if (options.tags && options.tags.length > 0) {
      if (!options.tags.every((t) => entry.tags.includes(t))) return false;
    }
    return true;
  }
}
