import { describe, it, expect } from 'vitest';
import { matchesFilters, applyFilters } from '../indexer/filter-utils.js';
import type { VaultEntry, SearchOptions } from '../types/index.js';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: overrides.id ?? 'test-id',
    name: overrides.name ?? 'test-entry',
    type: overrides.type ?? 'skill',
    source: overrides.source ?? 'custom',
    description: overrides.description ?? 'A test entry',
    filePath: overrides.filePath ?? '/tmp/test.md',
    tags: overrides.tags ?? ['test'],
    metadata: overrides.metadata ?? {},
    content: overrides.content ?? 'test content',
    lastModified: overrides.lastModified ?? new Date('2025-01-15'),
    favorite: overrides.favorite ?? false,
    usageCount: overrides.usageCount ?? 0,
  };
}

function makeOptions(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return { query: '', ...overrides };
}

describe('matchesFilters', () => {
  it('returns true when no filters are active', () => {
    const entry = makeEntry();
    expect(matchesFilters(entry, makeOptions())).toBe(true);
  });

  describe('type filter', () => {
    it('matches when type equals filter', () => {
      const entry = makeEntry({ type: 'agent' });
      expect(matchesFilters(entry, makeOptions({ type: 'agent' }))).toBe(true);
    });

    it('rejects when type does not match', () => {
      const entry = makeEntry({ type: 'skill' });
      expect(matchesFilters(entry, makeOptions({ type: 'agent' }))).toBe(false);
    });
  });

  describe('source filter', () => {
    it('matches when source equals filter', () => {
      const entry = makeEntry({ source: 'gstack' });
      expect(matchesFilters(entry, makeOptions({ source: 'gstack' }))).toBe(true);
    });

    it('rejects when source does not match', () => {
      const entry = makeEntry({ source: 'custom' });
      expect(matchesFilters(entry, makeOptions({ source: 'gstack' }))).toBe(false);
    });
  });

  describe('favorites filter', () => {
    it('matches favorited entry when favoritesOnly is true', () => {
      const entry = makeEntry({ favorite: true });
      expect(matchesFilters(entry, makeOptions({ favoritesOnly: true }))).toBe(true);
    });

    it('rejects non-favorite when favoritesOnly is true', () => {
      const entry = makeEntry({ favorite: false });
      expect(matchesFilters(entry, makeOptions({ favoritesOnly: true }))).toBe(false);
    });

    it('allows all entries when favoritesOnly is false', () => {
      const entry = makeEntry({ favorite: false });
      expect(matchesFilters(entry, makeOptions({ favoritesOnly: false }))).toBe(true);
    });
  });

  describe('tags filter', () => {
    it('matches when entry has all required tags', () => {
      const entry = makeEntry({ tags: ['deploy', 'security', 'aws'] });
      expect(matchesFilters(entry, makeOptions({ tags: ['deploy', 'security'] }))).toBe(true);
    });

    it('rejects when entry is missing a required tag', () => {
      const entry = makeEntry({ tags: ['deploy'] });
      expect(matchesFilters(entry, makeOptions({ tags: ['deploy', 'security'] }))).toBe(false);
    });

    it('matches with empty tags filter', () => {
      const entry = makeEntry({ tags: ['deploy'] });
      expect(matchesFilters(entry, makeOptions({ tags: [] }))).toBe(true);
    });

    it('rejects entry with no tags when filter requires tags', () => {
      const entry = makeEntry({ tags: [] });
      expect(matchesFilters(entry, makeOptions({ tags: ['security'] }))).toBe(false);
    });
  });

  describe('date filters', () => {
    it('matches when lastModified is after modifiedAfter', () => {
      const entry = makeEntry({ lastModified: new Date('2025-06-01') });
      expect(
        matchesFilters(entry, makeOptions({ modifiedAfter: new Date('2025-01-01') })),
      ).toBe(true);
    });

    it('rejects when lastModified is before modifiedAfter', () => {
      const entry = makeEntry({ lastModified: new Date('2024-01-01') });
      expect(
        matchesFilters(entry, makeOptions({ modifiedAfter: new Date('2025-01-01') })),
      ).toBe(false);
    });

    it('matches when lastModified is before modifiedBefore', () => {
      const entry = makeEntry({ lastModified: new Date('2025-01-01') });
      expect(
        matchesFilters(entry, makeOptions({ modifiedBefore: new Date('2025-06-01') })),
      ).toBe(true);
    });

    it('rejects when lastModified is after modifiedBefore', () => {
      const entry = makeEntry({ lastModified: new Date('2025-12-01') });
      expect(
        matchesFilters(entry, makeOptions({ modifiedBefore: new Date('2025-06-01') })),
      ).toBe(false);
    });

    it('supports combined date range (modifiedAfter + modifiedBefore)', () => {
      const inRange = makeEntry({ lastModified: new Date('2025-03-15') });
      const outOfRange = makeEntry({ lastModified: new Date('2025-08-01') });
      const opts = makeOptions({
        modifiedAfter: new Date('2025-01-01'),
        modifiedBefore: new Date('2025-06-01'),
      });
      expect(matchesFilters(inRange, opts)).toBe(true);
      expect(matchesFilters(outOfRange, opts)).toBe(false);
    });
  });

  describe('combined filters', () => {
    it('all filters must pass (AND logic)', () => {
      const entry = makeEntry({
        type: 'agent',
        source: 'gstack',
        favorite: true,
        tags: ['deploy', 'ci'],
        lastModified: new Date('2025-03-01'),
      });
      const opts = makeOptions({
        type: 'agent',
        source: 'gstack',
        favoritesOnly: true,
        tags: ['deploy'],
        modifiedAfter: new Date('2025-01-01'),
      });
      expect(matchesFilters(entry, opts)).toBe(true);
    });

    it('fails if any single filter does not match', () => {
      const entry = makeEntry({
        type: 'skill',
        source: 'gstack',
        favorite: true,
        tags: ['deploy'],
      });
      const opts = makeOptions({ type: 'agent', source: 'gstack', favoritesOnly: true });
      expect(matchesFilters(entry, opts)).toBe(false);
    });
  });
});

describe('applyFilters', () => {
  it('returns all entries when no filters active', () => {
    const entries = [makeEntry({ name: 'a' }), makeEntry({ name: 'b' })];
    expect(applyFilters(entries, makeOptions())).toHaveLength(2);
  });

  it('filters entries by type', () => {
    const entries = [
      makeEntry({ name: 'skill-1', type: 'skill' }),
      makeEntry({ name: 'agent-1', type: 'agent' }),
      makeEntry({ name: 'skill-2', type: 'skill' }),
    ];
    const result = applyFilters(entries, makeOptions({ type: 'skill' }));
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.type === 'skill')).toBe(true);
  });

  it('returns empty array when nothing matches', () => {
    const entries = [makeEntry({ type: 'skill' }), makeEntry({ type: 'skill' })];
    expect(applyFilters(entries, makeOptions({ type: 'hook' }))).toHaveLength(0);
  });

  it('does not mutate input array', () => {
    const entries = Object.freeze([
      makeEntry({ type: 'skill' }),
      makeEntry({ type: 'agent' }),
    ]) as readonly VaultEntry[];
    const result = applyFilters(entries, makeOptions({ type: 'skill' }));
    expect(result).toHaveLength(1);
    expect(entries).toHaveLength(2);
  });
});
