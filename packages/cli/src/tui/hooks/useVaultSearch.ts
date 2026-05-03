import { useState, useEffect, useRef } from 'react';
import type { Vault, SearchResult, EntryType, EntrySource } from '@commandvault/core';

const DEBOUNCE_MS = 80;

function sortedByUsage(vault: Vault): SearchResult[] {
  const entries = vault.getAllEntries();
  return [...entries]
    .sort((a, b) => b.usageCount - a.usageCount)
    .map((entry) => ({ entry, score: 1, matchedFields: [] as string[] }));
}

export function useVaultSearch(
  vault: Vault,
  query: string,
  filterType: EntryType | null,
  filterSource: EntrySource | null,
  onError: (err: Error) => void,
): SearchResult[] {
  const [results, setResults] = useState<SearchResult[]>(() => sortedByUsage(vault));
  const lastGood = useRef<SearchResult[]>(results);

  useEffect(() => {
    if (!query.trim()) {
      const mapped = sortedByUsage(vault);
      lastGood.current = mapped;
      setResults(mapped);
      return;
    }

    const timer = setTimeout(() => {
      try {
        const found = vault.search({
          query,
          type: filterType ?? undefined,
          source: filterSource ?? undefined,
          limit: 50,
          tier: 'fuse',
        });
        lastGood.current = found;
        setResults(found);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        setResults(lastGood.current);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [vault, query, filterType, filterSource, onError]);

  return results;
}
