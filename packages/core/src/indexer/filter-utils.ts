import type { VaultEntry, SearchOptions } from '../types/index.js';

/**
 * Shared filter predicate used by both Fuse and MiniSearch engines.
 * Returns true if the entry matches all active filter criteria.
 */
export function matchesFilters(entry: VaultEntry, options: SearchOptions): boolean {
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

/**
 * Applies filters to an array of entries, returning only those that match.
 */
export function applyFilters(entries: readonly VaultEntry[], options: SearchOptions): VaultEntry[] {
  return entries.filter((e) => matchesFilters(e, options));
}
