import { describe, it, expect, beforeEach } from 'vitest';
import { FuseEngine } from '../indexer/fuse-engine.js';
import { MiniSearchEngine } from '../indexer/minisearch-engine.js';
import { normalizeScore } from '../indexer/normalizer.js';
import type { VaultEntry, SearchResult, RankingWeights } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<VaultEntry> & { id: string; name: string }): VaultEntry {
  return {
    type: 'skill',
    source: 'custom',
    description: '',
    filePath: `/fake/${overrides.name}.md`,
    tags: [],
    metadata: {},
    content: '',
    lastModified: new Date(),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

const MOCK_ENTRIES: VaultEntry[] = [
  makeEntry({
    id: '001',
    name: 'browse',
    type: 'skill',
    source: 'gstack',
    description: 'Headless browser for QA testing',
    tags: ['browser', 'qa', 'testing'],
    content: 'Navigate URLs and interact with elements',
    usageCount: 42,
    favorite: true,
  }),
  makeEntry({
    id: '002',
    name: 'review',
    type: 'skill',
    source: 'gstack',
    description: 'Pre-landing PR review for code quality',
    tags: ['review', 'code'],
    content: 'Analyze diff for SQL safety and trust boundaries',
    usageCount: 30,
  }),
  makeEntry({
    id: '003',
    name: 'bmad-create-prd',
    type: 'skill',
    source: 'bmad',
    description: 'Create a product requirements document',
    tags: ['planning', 'prd'],
    content: 'Guided PRD creation with requirements discovery',
    usageCount: 15,
  }),
  makeEntry({
    id: '004',
    name: 'Test Agent',
    type: 'agent',
    source: 'custom',
    description: 'A custom testing agent',
    tags: ['testing', 'agent'],
    content: 'You are a test agent',
    usageCount: 5,
  }),
  makeEntry({
    id: '005',
    name: 'security-scan',
    type: 'command',
    source: 'mindforge',
    description: 'Run OWASP security scan on changed files',
    tags: ['security', 'owasp'],
    content: 'Scans for vulnerabilities',
    usageCount: 20,
  }),
  makeEntry({
    id: '006',
    name: 'test-plugin',
    type: 'plugin',
    source: 'community',
    description: 'Community plugin for testing utilities',
    tags: ['testing', 'plugin'],
    content: '{"name":"test-plugin"}',
    usageCount: 8,
  }),
  makeEntry({
    id: '007',
    name: 'coding style',
    type: 'rule',
    source: 'custom',
    description: 'Enforce coding style rules for the project',
    tags: ['rule', 'style'],
    content: 'Use camelCase for variables',
    usageCount: 0,
  }),
  makeEntry({
    id: '008',
    name: 'PreToolUse:Bash:guard',
    type: 'hook',
    source: 'custom',
    description: 'PreToolUse hook on Bash for destructive command guard',
    tags: ['hook', 'pretooluse', 'bash'],
    content: '// guard script',
    usageCount: 100,
  }),
  makeEntry({
    id: '009',
    name: 'deploy',
    type: 'skill',
    source: 'gstack',
    description: 'Deploy to production with canary checks',
    tags: ['deploy', 'devops'],
    content: 'Merges PR, waits for CI, verifies health',
    usageCount: 25,
    lastModified: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60), // 60 days ago
  }),
  makeEntry({
    id: '010',
    name: 'investigate',
    type: 'skill',
    source: 'gstack',
    description: 'Systematic debugging with root cause investigation',
    tags: ['debug', 'investigation'],
    content: 'Four phases: investigate, analyze, hypothesize, implement',
    usageCount: 12,
    lastModified: new Date(Date.now() - 1000 * 60 * 5), // 5 minutes ago
  }),
];

// ---------------------------------------------------------------------------
// FuseEngine
// ---------------------------------------------------------------------------
describe('FuseEngine', () => {
  let engine: FuseEngine;

  beforeEach(() => {
    engine = new FuseEngine();
    engine.index(MOCK_ENTRIES);
  });

  it('returns all entries for an empty query', () => {
    const results = engine.search({ query: '' });
    expect(results).toHaveLength(MOCK_ENTRIES.length);
    results.forEach((r) => {
      expect(r.score).toBe(1);
      expect(r.matchedFields).toEqual([]);
    });
  });

  it('finds exact name match', () => {
    const results = engine.search({ query: 'browse' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.name).toBe('browse');
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  it('performs fuzzy matching (typo tolerance)', () => {
    const results = engine.search({ query: 'brose' });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.entry.name);
    expect(names).toContain('browse');
  });

  it('matches on description content', () => {
    const results = engine.search({ query: 'OWASP' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.name).toBe('security-scan');
  });

  it('filters by type', () => {
    const results = engine.search({ query: '', type: 'agent' });
    expect(results).toHaveLength(1);
    expect(results[0].entry.type).toBe('agent');
  });

  it('filters by source', () => {
    const results = engine.search({ query: '', source: 'bmad' });
    expect(results).toHaveLength(1);
    expect(results[0].entry.source).toBe('bmad');
  });

  it('filters by tags', () => {
    const results = engine.search({ query: '', tags: ['security'] });
    expect(results).toHaveLength(1);
    expect(results[0].entry.name).toBe('security-scan');
  });

  it('filters favorites only', () => {
    const results = engine.search({ query: '', favoritesOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0].entry.favorite).toBe(true);
  });

  it('respects limit parameter', () => {
    const results = engine.search({ query: '', limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('combines type filter with query', () => {
    const results = engine.search({ query: 'testing', type: 'plugin' });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.entry.type).toBe('plugin');
    });
  });
});

// ---------------------------------------------------------------------------
// MiniSearchEngine
// ---------------------------------------------------------------------------
describe('MiniSearchEngine', () => {
  let engine: MiniSearchEngine;

  beforeEach(() => {
    engine = new MiniSearchEngine();
    engine.index(MOCK_ENTRIES);
  });

  it('returns all entries for an empty query', () => {
    const results = engine.search({ query: '' });
    expect(results).toHaveLength(MOCK_ENTRIES.length);
  });

  it('finds entries with prefix search', () => {
    const results = engine.search({ query: 'brow' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.name).toBe('browse');
  });

  it('boosts name matches over content matches', () => {
    const results = engine.search({ query: 'review' });
    expect(results.length).toBeGreaterThan(0);
    // "review" is the name of entry 002, so it should rank first
    expect(results[0].entry.name).toBe('review');
  });

  it('filters by type', () => {
    const results = engine.search({ query: '', type: 'hook' });
    expect(results).toHaveLength(1);
    expect(results[0].entry.type).toBe('hook');
  });

  it('filters by source', () => {
    const results = engine.search({ query: '', source: 'mindforge' });
    expect(results).toHaveLength(1);
    expect(results[0].entry.source).toBe('mindforge');
  });

  it('applies type filter together with query', () => {
    const results = engine.search({ query: 'testing', type: 'skill' });
    results.forEach((r) => {
      expect(r.entry.type).toBe('skill');
    });
  });

  it('provides suggestions via autoSuggest', () => {
    const suggestions = engine.suggest('brow');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toMatch(/brow/i);
  });

  it('returns matchedFields for search results', () => {
    const results = engine.search({ query: 'browse' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchedFields.length).toBeGreaterThan(0);
  });

  it('respects limit parameter', () => {
    const results = engine.search({ query: '', limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('handles queries with no matches gracefully', () => {
    const results = engine.search({ query: 'zzzznonexistentzzzzz' });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeScore
// ---------------------------------------------------------------------------
describe('normalizeScore', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeScore([])).toEqual([]);
  });

  it('applies text relevance weight to raw score', () => {
    const results: SearchResult[] = [
      { entry: MOCK_ENTRIES[0], score: 1.0, matchedFields: ['name'] },
      { entry: MOCK_ENTRIES[1], score: 0.5, matchedFields: ['name'] },
    ];

    const normalized = normalizeScore(results);
    // Higher raw score should still rank higher
    expect(normalized[0].entry.id).toBe('001');
    expect(normalized[0].score).toBeGreaterThan(normalized[1].score);
  });

  it('boosts favorites via favoriteBoost weight', () => {
    const notFavorite = makeEntry({
      id: 'nf',
      name: 'not-fav',
      favorite: false,
      usageCount: 0,
      lastModified: new Date(),
    });
    const isFavorite = makeEntry({
      id: 'fv',
      name: 'is-fav',
      favorite: true,
      usageCount: 0,
      lastModified: new Date(),
    });

    const results: SearchResult[] = [
      { entry: notFavorite, score: 0.5, matchedFields: [] },
      { entry: isFavorite, score: 0.5, matchedFields: [] },
    ];

    const normalized = normalizeScore(results);
    const favResult = normalized.find((r) => r.entry.id === 'fv')!;
    const noFavResult = normalized.find((r) => r.entry.id === 'nf')!;
    expect(favResult.score).toBeGreaterThan(noFavResult.score);
  });

  it('scores recently modified entries higher', () => {
    const recent = makeEntry({
      id: 'recent',
      name: 'recent-entry',
      lastModified: new Date(), // now
      usageCount: 0,
    });
    const old = makeEntry({
      id: 'old',
      name: 'old-entry',
      lastModified: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365), // 1 year ago
      usageCount: 0,
    });

    const results: SearchResult[] = [
      { entry: old, score: 0.5, matchedFields: [] },
      { entry: recent, score: 0.5, matchedFields: [] },
    ];

    const normalized = normalizeScore(results);
    const recentResult = normalized.find((r) => r.entry.id === 'recent')!;
    const oldResult = normalized.find((r) => r.entry.id === 'old')!;
    expect(recentResult.score).toBeGreaterThan(oldResult.score);
  });

  it('scores higher usage count entries higher', () => {
    const highUsage = makeEntry({
      id: 'high',
      name: 'high-usage',
      usageCount: 100,
      lastModified: new Date(),
    });
    const lowUsage = makeEntry({
      id: 'low',
      name: 'low-usage',
      usageCount: 1,
      lastModified: new Date(),
    });

    const results: SearchResult[] = [
      { entry: lowUsage, score: 0.5, matchedFields: [] },
      { entry: highUsage, score: 0.5, matchedFields: [] },
    ];

    const normalized = normalizeScore(results);
    const highResult = normalized.find((r) => r.entry.id === 'high')!;
    const lowResult = normalized.find((r) => r.entry.id === 'low')!;
    expect(highResult.score).toBeGreaterThan(lowResult.score);
  });

  it('accepts custom weights', () => {
    const entry = makeEntry({
      id: 'w1',
      name: 'weighted',
      favorite: true,
      usageCount: 50,
      lastModified: new Date(),
    });

    const results: SearchResult[] = [{ entry, score: 0.8, matchedFields: ['name'] }];

    const allTextWeight: Partial<RankingWeights> = {
      textRelevance: 1.0,
      recency: 0,
      usageFrequency: 0,
      favoriteBoost: 0,
    };
    const allFavoriteWeight: Partial<RankingWeights> = {
      textRelevance: 0,
      recency: 0,
      usageFrequency: 0,
      favoriteBoost: 1.0,
    };

    const textOnly = normalizeScore(results, allTextWeight);
    const favOnly = normalizeScore(results, allFavoriteWeight);

    // With all-text weight, score should be close to 0.8
    expect(textOnly[0].score).toBeCloseTo(0.8, 1);
    // With all-favorite weight, score should be 1.0 (favorite = true)
    expect(favOnly[0].score).toBeCloseTo(1.0, 1);
  });

  it('clamps scores between 0 and 1', () => {
    const entry = makeEntry({
      id: 'clamp',
      name: 'clamped',
      usageCount: 0,
      lastModified: new Date(),
    });

    const results: SearchResult[] = [{ entry, score: 2.0, matchedFields: [] }];

    const normalized = normalizeScore(results);
    expect(normalized[0].score).toBeLessThanOrEqual(1);
    expect(normalized[0].score).toBeGreaterThanOrEqual(0);
  });

  it('sorts results by final score descending', () => {
    const results: SearchResult[] = MOCK_ENTRIES.map((entry) => ({
      entry,
      score: Math.random(),
      matchedFields: ['name'],
    }));

    const normalized = normalizeScore(results);
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i - 1].score).toBeGreaterThanOrEqual(normalized[i].score);
    }
  });
});
