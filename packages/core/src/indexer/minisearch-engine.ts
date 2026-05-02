import { createHash } from 'node:crypto';
import MiniSearch from 'minisearch';
import type { VaultEntry, SearchResult, SearchOptions } from '../types/index.js';

const FIELDS = ['name', 'description', 'tags', 'source', 'type', 'content'];
const STORED_FIELDS = ['id'];
const BOOST = { name: 3, description: 2, tags: 1.5, source: 0.5, type: 0.5, content: 0.3 };

function entryToDoc(e: VaultEntry): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    tags: e.tags.join(' '),
    source: e.source,
    type: e.type,
    content: e.content.slice(0, 500),
  };
}

function entryHash(e: VaultEntry): string {
  return createHash('md5')
    .update(e.name + e.description + e.tags.join(',') + e.content.slice(0, 500))
    .digest('hex');
}

export class MiniSearchEngine {
  private engine: MiniSearch;
  private entriesById: Map<string, VaultEntry>;
  private hashById: Map<string, string> = new Map();

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
    const newMap = new Map(entries.map((e) => [e.id, e]));
    const isFirstIndex = this.entriesById.size === 0;

    if (isFirstIndex) {
      this.entriesById = newMap;
      this.hashById = new Map(entries.map((e) => [e.id, entryHash(e)]));
      this.engine = new MiniSearch({
        fields: FIELDS,
        storeFields: STORED_FIELDS,
        searchOptions: { boost: BOOST, prefix: true, fuzzy: 0.2 },
      });
      this.engine.addAll(entries.map(entryToDoc));
      return;
    }

    const oldIds = new Set(this.entriesById.keys());
    const newIds = new Set(newMap.keys());

    for (const id of oldIds) {
      if (!newIds.has(id)) {
        this.engine.discard(id);
        this.hashById.delete(id);
      }
    }

    for (const [id, entry] of newMap) {
      const newHash = entryHash(entry);
      const oldHash = this.hashById.get(id);

      if (!oldIds.has(id)) {
        this.engine.add(entryToDoc(entry));
        this.hashById.set(id, newHash);
      } else if (oldHash !== newHash) {
        this.engine.discard(id);
        this.engine.add(entryToDoc(entry));
        this.hashById.set(id, newHash);
      }
    }

    this.entriesById = newMap;
  }

  search(options: SearchOptions): SearchResult[] {
    const allEntries = [...this.entriesById.values()];
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;

    if (!options.query.trim()) {
      const filtered = this.applyFilters(allEntries, options);
      return filtered
        .slice(offset, offset + limit)
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

    return results.slice(offset, offset + limit);
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
    if (options.modifiedAfter && entry.lastModified < options.modifiedAfter) return false;
    if (options.modifiedBefore && entry.lastModified > options.modifiedBefore) return false;
    return true;
  }
}
