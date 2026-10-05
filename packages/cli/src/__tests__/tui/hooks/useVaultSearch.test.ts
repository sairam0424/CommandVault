import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Vault, VaultEntry, SearchResult } from '@commandvault/core';
import { useVaultSearch } from '../../../tui/hooks/useVaultSearch.js';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'entry-1',
    name: 'test-entry',
    type: 'skill',
    source: 'custom',
    description: 'A test entry',
    filePath: '/some/path.md',
    tags: [],
    metadata: {},
    content: '',
    lastModified: new Date('2024-01-01'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

function makeSearchResult(entry: VaultEntry, score = 0.9): SearchResult {
  return { entry, score, matchedFields: ['name'] };
}

function makeVault(entries: VaultEntry[], searchResults: SearchResult[]): Vault {
  return {
    search: vi.fn().mockReturnValue(searchResults),
    getAllEntries: vi.fn().mockReturnValue(entries),
  } as unknown as Vault;
}

describe('useVaultSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('empty query returns entries sorted by usageCount DESC', () => {
    const entries = [
      makeEntry({ id: 'a', usageCount: 5 }),
      makeEntry({ id: 'b', usageCount: 20 }),
      makeEntry({ id: 'c', usageCount: 1 }),
    ];
    const vault = makeVault(entries, []);
    const onError = vi.fn();

    const { result } = renderHook(() => useVaultSearch(vault, '', null, null, onError));

    expect(result.current.results).toHaveLength(3);
    expect(result.current.results[0].entry.id).toBe('b');
    expect(result.current.results[1].entry.id).toBe('a');
    expect(result.current.results[2].entry.id).toBe('c');
    expect(result.current.results[0].score).toBe(1);
    expect(result.current.results[0].matchedFields).toEqual([]);
    expect(vault.search).not.toHaveBeenCalled();
  });

  it('debounce: rapid query changes fire vault.search only once after 80ms', () => {
    const entries = [makeEntry()];
    const searchResults = [makeSearchResult(entries[0])];
    const vault = makeVault(entries, searchResults);
    const onError = vi.fn();

    const { rerender } = renderHook(
      ({ query }: { query: string }) => useVaultSearch(vault, query, null, null, onError),
      { initialProps: { query: 'a' } },
    );

    rerender({ query: 'ab' });
    rerender({ query: 'abc' });

    expect(vault.search).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(vault.search).toHaveBeenCalledTimes(1);
    expect(vault.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'abc' }));
  });

  it('debounce fires only once per burst (10 rapid rerenders → 1 search call)', () => {
    const entries = [makeEntry()];
    const searchResults = [makeSearchResult(entries[0])];
    const vault = makeVault(entries, searchResults);
    const onError = vi.fn();

    const { rerender } = renderHook(
      ({ query }: { query: string }) => useVaultSearch(vault, query, null, null, onError),
      { initialProps: { query: 'x' } },
    );

    for (let i = 0; i < 9; i++) {
      rerender({ query: `x${'y'.repeat(i + 1)}` });
    }

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(vault.search).toHaveBeenCalledTimes(1);
  });

  it('filterType and filterSource are passed to vault.search', () => {
    const entries = [makeEntry()];
    const searchResults = [makeSearchResult(entries[0])];
    const vault = makeVault(entries, searchResults);
    const onError = vi.fn();

    renderHook(() => useVaultSearch(vault, 'myquery', 'agent', 'gstack', onError));

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(vault.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'myquery',
        type: 'agent',
        source: 'gstack',
        limit: 50,
        tier: 'fuse',
      }),
    );
  });

  it('null filterType and filterSource are passed as undefined to vault.search', () => {
    const entries = [makeEntry()];
    const searchResults = [makeSearchResult(entries[0])];
    const vault = makeVault(entries, searchResults);
    const onError = vi.fn();

    renderHook(() => useVaultSearch(vault, 'query', null, null, onError));

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(vault.search).toHaveBeenCalledWith(
      expect.objectContaining({
        type: undefined,
        source: undefined,
      }),
    );
  });

  it('on error: onError called, previous results retained', () => {
    const entries = [makeEntry({ id: 'prev', usageCount: 3 })];
    const searchResults = [makeSearchResult(entries[0])];
    const vault = makeVault(entries, searchResults);
    const onError = vi.fn();

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useVaultSearch(vault, query, null, null, onError),
      { initialProps: { query: 'good' } },
    );

    // Advance timers to trigger first search (successful)
    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(result.current.results).toEqual(searchResults);

    // Now make search throw
    (vault.search as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('search failed');
    });

    rerender({ query: 'bad' });

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    // Previous results should be retained, not cleared
    expect(result.current.results).toEqual(searchResults);
  });

  it('query → empty: immediately returns usage-sorted (no debounce needed)', () => {
    const entries = [makeEntry({ id: 'x', usageCount: 10 }), makeEntry({ id: 'y', usageCount: 2 })];
    const vault = makeVault(entries, []);
    const onError = vi.fn();

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useVaultSearch(vault, query, null, null, onError),
      { initialProps: { query: 'something' } },
    );

    // Switch to empty query — no timer advance needed
    rerender({ query: '' });

    // Result should immediately be usage-sorted without advancing timers
    expect(result.current.results).toHaveLength(2);
    expect(result.current.results[0].entry.id).toBe('x');
    expect(result.current.results[1].entry.id).toBe('y');
    expect(result.current.results[0].score).toBe(1);
    expect(result.current.results[0].matchedFields).toEqual([]);
    expect(vault.search).not.toHaveBeenCalled();
  });

  it('whitespace-only query is treated as empty (returns usage-sorted immediately)', () => {
    const entries = [makeEntry({ id: 'z', usageCount: 7 })];
    const vault = makeVault(entries, []);
    const onError = vi.fn();

    const { result } = renderHook(() => useVaultSearch(vault, '   ', null, null, onError));

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].score).toBe(1);
    expect(vault.search).not.toHaveBeenCalled();
  });

  describe('resultsFor', () => {
    it('runs the search for a query whose debounce has not fired and reuses it after', () => {
      const found = [makeSearchResult(makeEntry({ id: 'x' }))];
      const vault = makeVault([makeEntry()], found);
      const { result } = renderHook(() => useVaultSearch(vault, 'abc', null, null, vi.fn()));
      expect(vault.search).not.toHaveBeenCalled();

      let now: SearchResult[] = [];
      act(() => {
        now = result.current.resultsFor('abc');
      });

      expect(now).toEqual(found);
      expect(vault.search).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(vault.search).toHaveBeenCalledTimes(1);
      expect(result.current.results).toEqual(found);
    });

    it('answers for text newer than the rendered query, which is what a batched read needs', () => {
      const found = [makeSearchResult(makeEntry({ id: 'x' }))];
      const vault = makeVault([makeEntry()], found);
      const { result } = renderHook(() => useVaultSearch(vault, '', null, null, vi.fn()));

      act(() => {
        result.current.resultsFor('typed-later');
      });

      expect(vault.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'typed-later' }));
    });

    it('returns the current list without searching again when it already answers the query', () => {
      const vault = makeVault([makeEntry()], [makeSearchResult(makeEntry())]);
      const { result } = renderHook(() => useVaultSearch(vault, 'abc', null, null, vi.fn()));
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(vault.search).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.resultsFor('abc');
      });

      expect(vault.search).toHaveBeenCalledTimes(1);
    });

    it('reports a failing search and falls back to the last good list', () => {
      const good = [makeSearchResult(makeEntry({ id: 'good' }))];
      const vault = makeVault([makeEntry()], good);
      const onError = vi.fn();
      const { result } = renderHook(() => useVaultSearch(vault, '', null, null, onError));
      vi.mocked(vault.search).mockImplementation(() => {
        throw new Error('index broken');
      });

      let now: SearchResult[] = [];
      act(() => {
        now = result.current.resultsFor('boom');
      });

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'index broken' }));
      expect(now.map((r) => r.entry.id)).toEqual([makeEntry().id]);
    });
  });
});
