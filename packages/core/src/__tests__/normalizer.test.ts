import { describe, it, expect } from 'vitest';
import { normalizeScore } from '../indexer/normalizer.js';
import type { SearchResult, VaultEntry } from '../types/index.js';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: overrides.id ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? 'test-entry',
    type: overrides.type ?? 'skill',
    source: overrides.source ?? 'custom',
    description: overrides.description ?? 'A test entry',
    filePath: overrides.filePath ?? '/tmp/test.md',
    tags: overrides.tags ?? ['test'],
    metadata: overrides.metadata ?? {},
    content: overrides.content ?? 'test content',
    lastModified: overrides.lastModified ?? new Date(),
    favorite: overrides.favorite ?? false,
    usageCount: overrides.usageCount ?? 0,
  };
}

function makeResult(
  overrides: { score?: number; matchedFields?: string[]; entry?: Partial<VaultEntry> } = {},
): SearchResult {
  return {
    entry: makeEntry(overrides.entry),
    score: overrides.score ?? 0.5,
    matchedFields: overrides.matchedFields ?? ['name'],
  };
}

describe('normalizeScore', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeScore([])).toEqual([]);
  });

  it('clamps scores to [0, 1] range', () => {
    const results = [makeResult({ score: 5.0, entry: { usageCount: 100, favorite: true } })];
    const normalized = normalizeScore(results);
    expect(normalized[0].score).toBeGreaterThanOrEqual(0);
    expect(normalized[0].score).toBeLessThanOrEqual(1);
  });

  it('clamps negative input scores to 0', () => {
    const results = [makeResult({ score: -0.5 })];
    const normalized = normalizeScore(results);
    expect(normalized[0].score).toBeGreaterThanOrEqual(0);
  });

  it('ranks recently modified entries higher via recency score', () => {
    const recent = makeResult({
      score: 0.5,
      entry: { lastModified: new Date(), name: 'recent' },
    });
    const old = makeResult({
      score: 0.5,
      entry: { lastModified: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), name: 'old' },
    });
    const normalized = normalizeScore([old, recent]);
    expect(normalized[0].entry.name).toBe('recent');
    expect(normalized[0].score).toBeGreaterThan(normalized[1].score);
  });

  it('ranks high-usage entries higher via usage score', () => {
    const popular = makeResult({
      score: 0.5,
      entry: { usageCount: 50, name: 'popular' },
    });
    const unused = makeResult({
      score: 0.5,
      entry: { usageCount: 0, name: 'unused' },
    });
    const normalized = normalizeScore([unused, popular]);
    expect(normalized[0].entry.name).toBe('popular');
  });

  it('favorite entries get a boost', () => {
    const fav = makeResult({
      score: 0.5,
      entry: { favorite: true, name: 'favorited', usageCount: 0 },
    });
    const normal = makeResult({
      score: 0.5,
      entry: { favorite: false, name: 'normal', usageCount: 0 },
    });
    const normalized = normalizeScore([normal, fav]);
    expect(normalized[0].entry.name).toBe('favorited');
  });

  it('text relevance dominates with default weights (0.55)', () => {
    const highText = makeResult({
      score: 1.0,
      entry: { usageCount: 0, favorite: false, name: 'high-text' },
    });
    const highUsage = makeResult({
      score: 0.1,
      entry: { usageCount: 100, favorite: true, name: 'high-usage' },
    });
    const normalized = normalizeScore([highUsage, highText]);
    expect(normalized[0].entry.name).toBe('high-text');
  });

  it('respects custom weights', () => {
    const fav = makeResult({
      score: 0.1,
      entry: { favorite: true, name: 'fav', usageCount: 0 },
    });
    const highText = makeResult({
      score: 0.9,
      entry: { favorite: false, name: 'high-text', usageCount: 0 },
    });
    const normalized = normalizeScore([highText, fav], {
      textRelevance: 0.1,
      favoriteBoost: 0.9,
    });
    expect(normalized[0].entry.name).toBe('fav');
  });

  it('applies name bonus when query matches entry name', () => {
    const match = makeResult({
      score: 0.5,
      entry: { name: 'deploy-script', usageCount: 0 },
    });
    const noMatch = makeResult({
      score: 0.5,
      entry: { name: 'other-thing', usageCount: 0 },
    });
    const normalized = normalizeScore([noMatch, match], undefined, 'deploy');
    expect(normalized[0].entry.name).toBe('deploy-script');
  });

  it('name bonus is case-insensitive', () => {
    const match = makeResult({
      score: 0.5,
      entry: { name: 'MySkill', usageCount: 0 },
    });
    const noMatch = makeResult({
      score: 0.5,
      entry: { name: 'other', usageCount: 0 },
    });
    const normalized = normalizeScore([noMatch, match], undefined, 'myskill');
    expect(normalized[0].entry.name).toBe('MySkill');
  });

  it('handles all entries having zero usage gracefully', () => {
    const results = [
      makeResult({ score: 0.8, entry: { usageCount: 0, name: 'a' } }),
      makeResult({ score: 0.6, entry: { usageCount: 0, name: 'b' } }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].entry.name).toBe('a');
  });

  it('handles future lastModified dates without NaN', () => {
    const futureEntry = makeResult({
      score: 0.5,
      entry: { lastModified: new Date(Date.now() + 86400000), name: 'future' },
    });
    const normalized = normalizeScore([futureEntry]);
    expect(normalized[0].score).not.toBeNaN();
    expect(normalized[0].score).toBeGreaterThanOrEqual(0);
    expect(normalized[0].score).toBeLessThanOrEqual(1);
  });

  it('handles single result correctly', () => {
    const single = makeResult({ score: 0.7, entry: { usageCount: 5 } });
    const normalized = normalizeScore([single]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].score).toBeGreaterThan(0);
  });

  it('sorts output by score descending', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ score: Math.random(), entry: { name: `entry-${i}`, usageCount: i } }),
    );
    const normalized = normalizeScore(results);
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i - 1].score).toBeGreaterThanOrEqual(normalized[i].score);
    }
  });

  it('does not mutate input array', () => {
    const results = [
      makeResult({ score: 0.3, entry: { name: 'c' } }),
      makeResult({ score: 0.9, entry: { name: 'a' } }),
      makeResult({ score: 0.6, entry: { name: 'b' } }),
    ];
    const originalOrder = results.map((r) => r.entry.name);
    normalizeScore(results);
    expect(results.map((r) => r.entry.name)).toEqual(originalOrder);
  });

  it('recency decay: entry 14 days old gets exp(-1) ≈ 0.368 recency score', () => {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const results = [
      makeResult({ score: 0, entry: { lastModified: fourteenDaysAgo, usageCount: 0 } }),
    ];
    const normalized = normalizeScore(results, {
      textRelevance: 0,
      recency: 1,
      usageFrequency: 0,
      favoriteBoost: 0,
    });
    expect(normalized[0].score).toBeCloseTo(Math.exp(-1), 2);
  });
});
