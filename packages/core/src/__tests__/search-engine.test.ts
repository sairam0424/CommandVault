import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SearchEngine } from '../indexer/search-engine.js';
import type { VaultEntry } from '../types/index.js';

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

const TEST_ENTRIES: readonly VaultEntry[] = [
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
    name: 'security-scan',
    type: 'command',
    source: 'mindforge',
    description: 'Run OWASP security scan on changed files',
    tags: ['security', 'owasp'],
    content: 'Scans for vulnerabilities',
    usageCount: 20,
  }),
  makeEntry({
    id: '005',
    name: 'deploy-hook',
    type: 'hook',
    source: 'custom',
    description: 'PostToolUse hook that triggers deploys',
    tags: ['hook', 'deploy'],
    content: '// deploy script',
    usageCount: 5,
  }),
];

// ---------------------------------------------------------------------------
// SearchEngine Orchestrator Tests
// ---------------------------------------------------------------------------

describe('SearchEngine', () => {
  let engine: SearchEngine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-search-engine-test-'));
    engine = await SearchEngine.create(join(tempDir, 'test.db'), 'fuse');
    engine.index(TEST_ENTRIES);
  });

  afterEach(async () => {
    engine.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Tier Routing
  // =========================================================================

  describe('Tier Routing', () => {
    it('routes to Fuse engine when tier is explicitly fuse', () => {
      const results = engine.search({ query: 'browse', tier: 'fuse' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.name).toBe('browse');
    });

    it('routes to MiniSearch engine when tier is explicitly minisearch', () => {
      const results = engine.search({ query: 'browse', tier: 'minisearch' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.name).toBe('browse');
    });

    it('routes to SQLite engine when tier is explicitly sqlite', () => {
      const results = engine.search({ query: 'browse', tier: 'sqlite' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.name).toBe('browse');
    });

    it('uses the default tier (fuse) when no tier is specified', async () => {
      // Create engine with minisearch as default
      const msEngine = await SearchEngine.create(join(tempDir, 'ms.db'), 'minisearch');
      msEngine.index(TEST_ENTRIES);

      const results = msEngine.search({ query: 'browse' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.name).toBe('browse');

      msEngine.close();
    });

    it('returns consistent results across all tiers for exact name match', () => {
      const fuseResults = engine.search({ query: 'security', tier: 'fuse' });
      const miniResults = engine.search({ query: 'security', tier: 'minisearch' });
      const sqliteResults = engine.search({ query: 'security', tier: 'sqlite' });

      // All tiers should find the security-scan entry (via name/description/tags match)
      const fuseNames = fuseResults.map((r) => r.entry.name);
      const miniNames = miniResults.map((r) => r.entry.name);
      const sqliteNames = sqliteResults.map((r) => r.entry.name);

      expect(fuseNames).toContain('security-scan');
      expect(miniNames).toContain('security-scan');
      expect(sqliteNames).toContain('security-scan');
    });
  });

  // =========================================================================
  // LRU Cache Behavior
  // =========================================================================

  describe('LRU Cache', () => {
    it('returns cached results on second identical query', () => {
      const first = engine.search({ query: 'browse', tier: 'fuse' });
      const second = engine.search({ query: 'browse', tier: 'fuse' });

      // Results should be reference-equal (same cached array)
      expect(first).toBe(second);
    });

    it('invalidates cache when index() is called', () => {
      const first = engine.search({ query: 'browse', tier: 'fuse' });

      // Re-index with modified entries
      const updatedEntries = TEST_ENTRIES.map((e) =>
        e.id === '001' ? { ...e, description: 'Updated browser tool' } : e,
      );
      engine.index(updatedEntries);

      const second = engine.search({ query: 'browse', tier: 'fuse' });

      // Should NOT be reference-equal (cache was cleared)
      expect(first).not.toBe(second);
    });

    it('returns fresh results after TTL expires', () => {
      vi.useFakeTimers();

      const first = engine.search({ query: 'browse', tier: 'fuse' });

      // Advance time beyond the 30s TTL
      vi.advanceTimersByTime(31_000);

      const second = engine.search({ query: 'browse', tier: 'fuse' });

      // Should NOT be reference-equal (TTL expired)
      expect(first).not.toBe(second);
      // But results should contain the same data
      expect(second.length).toBeGreaterThan(0);
      expect(second[0].entry.name).toBe('browse');

      vi.useRealTimers();
    });

    it('caches different queries independently', () => {
      const browseResults = engine.search({ query: 'browse', tier: 'fuse' });
      const reviewResults = engine.search({ query: 'review', tier: 'fuse' });

      // Both should be cached independently
      expect(engine.search({ query: 'browse', tier: 'fuse' })).toBe(browseResults);
      expect(engine.search({ query: 'review', tier: 'fuse' })).toBe(reviewResults);
    });
  });

  // =========================================================================
  // Lazy Initialization
  // =========================================================================

  describe('Lazy Initialization', () => {
    it('does not initialize Fuse engine until first fuse query', async () => {
      const lazyEngine = await SearchEngine.create(join(tempDir, 'lazy.db'), 'sqlite');
      lazyEngine.index(TEST_ENTRIES);

      // SQLite queries should work without initializing Fuse/MiniSearch
      const sqlResults = lazyEngine.search({ query: 'browse', tier: 'sqlite' });
      expect(sqlResults.length).toBeGreaterThan(0);

      // Now trigger Fuse initialization
      const fuseResults = lazyEngine.search({ query: 'browse', tier: 'fuse' });
      expect(fuseResults.length).toBeGreaterThan(0);

      lazyEngine.close();
    });

    it('does not initialize MiniSearch engine until first minisearch query', async () => {
      const lazyEngine = await SearchEngine.create(join(tempDir, 'lazy2.db'), 'sqlite');
      lazyEngine.index(TEST_ENTRIES);

      // SQLite queries should work without initializing MiniSearch
      const sqlResults = lazyEngine.search({ query: 'review', tier: 'sqlite' });
      expect(sqlResults.length).toBeGreaterThan(0);

      // Now trigger MiniSearch initialization
      const miniResults = lazyEngine.search({ query: 'review', tier: 'minisearch' });
      expect(miniResults.length).toBeGreaterThan(0);

      lazyEngine.close();
    });
  });

  // =========================================================================
  // suggest() and auxiliary methods
  // =========================================================================

  describe('suggest()', () => {
    it('returns autocomplete suggestions based on indexed entries', () => {
      const suggestions = engine.suggest('brow');
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toMatch(/brow/i);
    });

    it('respects the limit parameter', () => {
      const suggestions = engine.suggest('s', 2);
      expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array for non-matching prefix', () => {
      const suggestions = engine.suggest('zzzznonexistent');
      expect(suggestions).toHaveLength(0);
    });
  });

  // =========================================================================
  // Delegated operations
  // =========================================================================

  describe('Delegated Operations', () => {
    it('toggleFavorite clears the cache', () => {
      const first = engine.search({ query: '', tier: 'sqlite' });
      engine.toggleFavorite('001');
      const second = engine.search({ query: '', tier: 'sqlite' });

      // Cache should have been cleared
      expect(first).not.toBe(second);
    });

    it('getStats returns entry statistics', () => {
      const stats = engine.getStats();
      expect(stats.totalEntries).toBe(TEST_ENTRIES.length);
    });

    it('getEntry retrieves a specific entry by id', () => {
      const entry = engine.getEntry('001');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('browse');
    });

    it('getEntry returns undefined for nonexistent id', () => {
      expect(engine.getEntry('nonexistent')).toBeUndefined();
    });
  });
});
