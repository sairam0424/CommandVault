import { useState, useEffect, useRef, useCallback } from 'react';
import type { Vault, SearchResult, EntryType, EntrySource } from '@commandvault/core';

const DEBOUNCE_MS = 80;
const SEARCH_LIMIT = 50;

export interface VaultSearch {
  readonly results: SearchResult[];
  /**
   * The results for `query` right now. While the debounced search for it has
   * not run yet (text typed in the same read as a key that acts on a result),
   * it runs the search at once, so the key never acts on the previous list.
   */
  readonly resultsFor: (query: string) => SearchResult[];
}

function sortedByUsage(vault: Vault): SearchResult[] {
  const entries = vault.getAllEntries();
  return [...entries]
    .sort((a, b) => b.usageCount - a.usageCount)
    .map((entry) => ({ entry, score: 1, matchedFields: [] as string[] }));
}

const searchKey = (query: string, type: EntryType | null, source: EntrySource | null): string =>
  JSON.stringify([query, type, source]);

export function useVaultSearch(
  vault: Vault,
  query: string,
  filterType: EntryType | null,
  filterSource: EntrySource | null,
  onError: (err: Error) => void,
): VaultSearch {
  const [results, setResults] = useState<SearchResult[]>(() => sortedByUsage(vault));
  const lastGood = useRef<SearchResult[]>(results);
  // The query and filters that `lastGood` answers.
  const settledKey = useRef(searchKey('', null, null));
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  const runSearch = useCallback(
    (text: string): SearchResult[] => {
      if (!text.trim()) {
        lastGood.current = sortedByUsage(vault);
        settledKey.current = searchKey(text, filterType, filterSource);
        setResults(lastGood.current);
        return lastGood.current;
      }
      try {
        const found = vault.search({
          query: text,
          type: filterType ?? undefined,
          source: filterSource ?? undefined,
          limit: SEARCH_LIMIT,
          tier: 'fuse',
        });
        lastGood.current = found;
        settledKey.current = searchKey(text, filterType, filterSource);
        setResults(found);
      } catch (err) {
        onErrorRef.current(err instanceof Error ? err : new Error(String(err)));
        setResults(lastGood.current);
      }
      return lastGood.current;
    },
    [vault, filterType, filterSource],
  );

  useEffect(() => {
    if (!query.trim()) {
      runSearch(query);
      return;
    }
    const key = searchKey(query, filterType, filterSource);
    const timer = setTimeout(() => {
      // A key that needed the list sooner has already run this search.
      if (settledKey.current !== key) runSearch(query);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, filterType, filterSource, runSearch]);

  const resultsFor = useCallback(
    (text: string): SearchResult[] =>
      settledKey.current === searchKey(text, filterType, filterSource)
        ? lastGood.current
        : runSearch(text),
    [filterType, filterSource, runSearch],
  );

  return { results, resultsFor };
}
