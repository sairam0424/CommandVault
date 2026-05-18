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

    expect(result.current).toHaveLength(3);
    expect(result.current[0].entry.id).toBe('b');
    expect(result.current[1].entry.id).toBe('a');
    expect(result.current[2].entry.id).toBe('c');
    expect(result.current[0].score).toBe(1);
    expect(result.current[0].matchedFields).toEqual([]);
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

    expect(result.current).toEqual(searchResults);

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
    expect(result.current).toEqual(searchResults);
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
    expect(result.current).toHaveLength(2);
    expect(result.current[0].entry.id).toBe('x');
    expect(result.current[1].entry.id).toBe('y');
    expect(result.current[0].score).toBe(1);
    expect(result.current[0].matchedFields).toEqual([]);
    expect(vault.search).not.toHaveBeenCalled();
  });

  it('whitespace-only query is treated as empty (returns usage-sorted immediately)', () => {
    const entries = [makeEntry({ id: 'z', usageCount: 7 })];
    const vault = makeVault(entries, []);
    const onError = vi.fn();

    const { result } = renderHook(() => useVaultSearch(vault, '   ', null, null, onError));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].score).toBe(1);
    expect(vault.search).not.toHaveBeenCalled();
  });
});
