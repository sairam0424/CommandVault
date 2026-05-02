import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import type { VaultEntry, EntryType, EntrySource } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SqliteEngine', () => {
  let engine: SqliteEngine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-sqlite-test-'));
    engine = await SqliteEngine.create(join(tempDir, 'test.db'));
  });

  afterEach(async () => {
    engine.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Entry Store
  // =========================================================================

  describe('Entry Store', () => {
    it('index() stores entries that can be retrieved', () => {
      const entry = makeEntry({ id: 'e1', name: 'alpha-tool' });
      engine.index([entry]);

      const retrieved = engine.getEntry('e1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('e1');
      expect(retrieved!.name).toBe('alpha-tool');
      expect(retrieved!.type).toBe('skill');
      expect(retrieved!.source).toBe('custom');
    });

    it('index() replaces existing entries on re-index', () => {
      const v1 = makeEntry({ id: 'e1', name: 'tool', description: 'version one' });
      engine.index([v1]);

      const v2 = makeEntry({ id: 'e1', name: 'tool', description: 'version two' });
      engine.index([v2]);

      const retrieved = engine.getEntry('e1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.description).toBe('version two');
    });

    it('index() removes entries that are no longer present', () => {
      const e1 = makeEntry({ id: 'e1', name: 'stays' });
      const e2 = makeEntry({ id: 'e2', name: 'goes-away' });
      engine.index([e1, e2]);

      engine.index([e1]);

      expect(engine.getEntry('e1')).toBeDefined();
      expect(engine.getEntry('e2')).toBeUndefined();
    });

    it('index() preserves favorite state across re-index', () => {
      const entry = makeEntry({ id: 'e1', name: 'fav-tool' });
      engine.index([entry]);
      engine.toggleFavorite('e1');

      const updated = makeEntry({ id: 'e1', name: 'fav-tool', description: 'updated' });
      engine.index([updated]);

      const retrieved = engine.getEntry('e1');
      expect(retrieved!.favorite).toBe(true);
    });

    it('index() preserves usage count across re-index', () => {
      const entry = makeEntry({ id: 'e1', name: 'used-tool' });
      engine.index([entry]);
      engine.incrementUsage('e1');
      engine.incrementUsage('e1');

      const updated = makeEntry({ id: 'e1', name: 'used-tool', description: 'refreshed' });
      engine.index([updated]);

      const retrieved = engine.getEntry('e1');
      expect(retrieved!.usageCount).toBe(2);
    });

    it('search() with empty query returns all entries (up to limit)', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'alpha' }),
        makeEntry({ id: 'e2', name: 'beta' }),
        makeEntry({ id: 'e3', name: 'gamma' }),
      ]);

      const results = engine.search({ query: '', limit: 50 });
      expect(results).toHaveLength(3);
    });

    it('search() with query matches name', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'deploy-tool', description: 'unrelated' }),
        makeEntry({ id: 'e2', name: 'test-runner', description: 'unrelated' }),
      ]);

      const results = engine.search({ query: 'deploy', limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('deploy-tool');
    });

    it('search() with query matches description', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'toolA', description: 'handles database migrations' }),
        makeEntry({ id: 'e2', name: 'toolB', description: 'runs unit tests' }),
      ]);

      const results = engine.search({ query: 'migrations', limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('toolA');
    });

    it('search() filters by type', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'my-skill', type: 'skill' }),
        makeEntry({ id: 'e2', name: 'my-agent', type: 'agent' }),
        makeEntry({ id: 'e3', name: 'my-hook', type: 'hook' }),
      ]);

      const results = engine.search({ query: '', type: 'agent', limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('my-agent');
    });

    it('search() filters by source', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'gstack-tool', source: 'gstack' }),
        makeEntry({ id: 'e2', name: 'bmad-tool', source: 'bmad' }),
      ]);

      const results = engine.search({ query: '', source: 'gstack', limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('gstack-tool');
    });

    it('search() filters by favoritesOnly', () => {
      const entry1 = makeEntry({ id: 'e1', name: 'fav' });
      const entry2 = makeEntry({ id: 'e2', name: 'normal' });
      engine.index([entry1, entry2]);
      engine.toggleFavorite('e1');

      const results = engine.search({ query: '', favoritesOnly: true, limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('fav');
    });

    it('search() respects limit', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'alpha' }),
        makeEntry({ id: 'e2', name: 'beta' }),
        makeEntry({ id: 'e3', name: 'gamma' }),
        makeEntry({ id: 'e4', name: 'delta' }),
        makeEntry({ id: 'e5', name: 'epsilon' }),
      ]);

      const results = engine.search({ query: '', limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('search() respects offset for pagination', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'a-first' }),
        makeEntry({ id: 'e2', name: 'b-second' }),
        makeEntry({ id: 'e3', name: 'c-third' }),
        makeEntry({ id: 'e4', name: 'd-fourth' }),
      ]);

      const page1 = engine.search({ query: '', limit: 2, offset: 0 });
      const page2 = engine.search({ query: '', limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);

      const page1Names = page1.map((r) => r.entry.name);
      const page2Names = page2.map((r) => r.entry.name);
      const allNames = [...page1Names, ...page2Names];
      expect(new Set(allNames).size).toBe(4);
    });

    it('search() with modifiedAfter filters correctly', () => {
      const oldDate = new Date('2024-01-01T00:00:00Z');
      const newDate = new Date('2025-06-01T00:00:00Z');
      const cutoff = new Date('2025-01-01T00:00:00Z');

      engine.index([
        makeEntry({ id: 'e1', name: 'old-entry', lastModified: oldDate }),
        makeEntry({ id: 'e2', name: 'new-entry', lastModified: newDate }),
      ]);

      const results = engine.search({ query: '', modifiedAfter: cutoff, limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('new-entry');
    });

    it('search() matches content field', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'toolA', content: 'handles kubernetes deployments' }),
        makeEntry({ id: 'e2', name: 'toolB', content: 'manages git branches' }),
      ]);

      const results = engine.search({ query: 'kubernetes', limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('toolA');
    });

    it('toggleFavorite() toggles and returns new state', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool' })]);

      const firstToggle = engine.toggleFavorite('e1');
      expect(firstToggle).toBe(true);

      const entry1 = engine.getEntry('e1');
      expect(entry1!.favorite).toBe(true);

      const secondToggle = engine.toggleFavorite('e1');
      expect(secondToggle).toBe(false);

      const entry2 = engine.getEntry('e1');
      expect(entry2!.favorite).toBe(false);
    });

    it('toggleFavorite() returns false for nonexistent entry', () => {
      const result = engine.toggleFavorite('nonexistent');
      expect(result).toBe(false);
    });

    it('incrementUsage() increases count', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool' })]);

      engine.incrementUsage('e1');
      const after1 = engine.getEntry('e1');
      expect(after1!.usageCount).toBe(1);

      engine.incrementUsage('e1');
      engine.incrementUsage('e1');
      const after3 = engine.getEntry('e1');
      expect(after3!.usageCount).toBe(3);
    });

    it('search() orders by usage_count descending', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'low-usage' }),
        makeEntry({ id: 'e2', name: 'high-usage' }),
      ]);
      engine.incrementUsage('e2');
      engine.incrementUsage('e2');
      engine.incrementUsage('e2');

      const results = engine.search({ query: '', limit: 50 });
      expect(results[0].entry.name).toBe('high-usage');
    });

    it('getEntry() returns undefined for nonexistent id', () => {
      expect(engine.getEntry('does-not-exist')).toBeUndefined();
    });
  });

  // =========================================================================
  // Tag Store
  // =========================================================================

  describe('Tag Store', () => {
    it('addTag() adds a user tag', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool', tags: ['original'] })]);
      engine.addTag('e1', 'custom-tag');

      const tags = engine.getTagsForEntry('e1');
      expect(tags).toContain('custom-tag');
    });

    it('removeTag() removes a user tag', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool' })]);
      engine.addTag('e1', 'removable');
      engine.removeTag('e1', 'removable');

      const tags = engine.getTagsForEntry('e1');
      expect(tags).not.toContain('removable');
    });

    it('adding duplicate tag is idempotent', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool' })]);
      engine.addTag('e1', 'dup');
      engine.addTag('e1', 'dup');

      const tags = engine.getTagsForEntry('e1');
      const dupCount = tags.filter((t) => t === 'dup').length;
      expect(dupCount).toBe(1);
    });

    it('tags from index (entry_tags) appear in retrieved entry', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tagged-tool', tags: ['deploy', 'ci'] })]);

      const entry = engine.getEntry('e1');
      expect(entry!.tags).toContain('deploy');
      expect(entry!.tags).toContain('ci');
    });

    it('user tags and entry tags both appear when retrieving entry', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool', tags: ['original'] })]);
      engine.addTag('e1', 'user-added');

      const entry = engine.getEntry('e1');
      expect(entry!.tags).toContain('original');
      expect(entry!.tags).toContain('user-added');
    });

    it('user tags are searchable via tag filter', () => {
      engine.index([makeEntry({ id: 'e1', name: 'tool', tags: ['builtin'] })]);
      engine.addTag('e1', 'custom-filter');

      const results = engine.search({ query: '', tags: ['custom-filter'], limit: 50 });
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe('tool');
    });
  });

  // =========================================================================
  // Snapshot Store
  // =========================================================================

  describe('Snapshot Store', () => {
    it('saveSnapshot() stores snapshot data', () => {
      const entries = [
        makeEntry({ id: 'e1', name: 'tool-a', content: 'content a' }),
        makeEntry({ id: 'e2', name: 'tool-b', content: 'content b' }),
      ];
      engine.index(entries);
      engine.saveSnapshot(entries);

      const diff = engine.getDiff(entries);
      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
    });

    it('getDiff() detects added entries', () => {
      const original = [makeEntry({ id: 'e1', name: 'existing', content: 'orig' })];
      engine.index(original);
      engine.saveSnapshot(original);

      const withNew = [...original, makeEntry({ id: 'e2', name: 'brand-new', content: 'fresh' })];

      const diff = engine.getDiff(withNew);
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].name).toBe('brand-new');
      expect(diff.removed).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
    });

    it('getDiff() detects removed entries', () => {
      const entries = [
        makeEntry({ id: 'e1', name: 'keeper', content: 'keep' }),
        makeEntry({ id: 'e2', name: 'goner', content: 'bye' }),
      ];
      engine.index(entries);
      engine.saveSnapshot(entries);

      const remaining = [entries[0]];
      const diff = engine.getDiff(remaining);

      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed).toContain('goner');
      expect(diff.modified).toHaveLength(0);
    });

    it('getDiff() detects modified entries (content hash change)', () => {
      const entry = makeEntry({ id: 'e1', name: 'mutable', content: 'version 1' });
      engine.index([entry]);
      engine.saveSnapshot([entry]);

      const modified = { ...entry, content: 'version 2' };
      const diff = engine.getDiff([modified]);

      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].name).toBe('mutable');
    });

    it('saveSnapshot() replaces previous snapshot entirely', () => {
      const batch1 = [makeEntry({ id: 'e1', name: 'old-tool', content: 'old' })];
      engine.saveSnapshot(batch1);

      const batch2 = [makeEntry({ id: 'e2', name: 'new-tool', content: 'new' })];
      engine.saveSnapshot(batch2);

      const diff = engine.getDiff(batch2);
      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
    });
  });

  // =========================================================================
  // Stats Store
  // =========================================================================

  describe('Stats Store', () => {
    it('getStats() returns correct counts by type', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 's1', type: 'skill' }),
        makeEntry({ id: 'e2', name: 's2', type: 'skill' }),
        makeEntry({ id: 'e3', name: 'a1', type: 'agent' }),
        makeEntry({ id: 'e4', name: 'h1', type: 'hook' }),
      ]);

      const stats = engine.getStats();
      expect(stats.totalEntries).toBe(4);
      expect(stats.byType.skill).toBe(2);
      expect(stats.byType.agent).toBe(1);
      expect(stats.byType.hook).toBe(1);
    });

    it('getStats() returns correct counts by source', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'g1', source: 'gstack' }),
        makeEntry({ id: 'e2', name: 'g2', source: 'gstack' }),
        makeEntry({ id: 'e3', name: 'b1', source: 'bmad' }),
        makeEntry({ id: 'e4', name: 'c1', source: 'custom' }),
      ]);

      const stats = engine.getStats();
      expect(stats.totalEntries).toBe(4);
      expect(stats.bySource.gstack).toBe(2);
      expect(stats.bySource.bmad).toBe(1);
      expect(stats.bySource.custom).toBe(1);
    });

    it('getStats() returns correct favorite count', () => {
      engine.index([
        makeEntry({ id: 'e1', name: 'fav1' }),
        makeEntry({ id: 'e2', name: 'fav2' }),
        makeEntry({ id: 'e3', name: 'normal' }),
      ]);
      engine.toggleFavorite('e1');
      engine.toggleFavorite('e2');

      const stats = engine.getStats();
      expect(stats.favoriteCount).toBe(2);
    });

    it('getStats() returns zero counts on empty database', () => {
      const stats = engine.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.favoriteCount).toBe(0);
    });
  });

  // =========================================================================
  // Migrations
  // =========================================================================

  describe('Migrations', () => {
    it('fresh database gets all migrations applied', async () => {
      // The engine was already created in beforeEach, so migrations ran.
      // Verify the entry_tags table exists by inserting and querying it.
      engine.index([makeEntry({ id: 'e1', name: 'tool', tags: ['alpha', 'beta'] })]);

      const entry = engine.getEntry('e1');
      expect(entry!.tags).toContain('alpha');
      expect(entry!.tags).toContain('beta');
    });

    it('schema version is tracked correctly', async () => {
      // Create a second engine on the same DB file to verify version tracking.
      const dbPath = join(tempDir, 'test.db');
      engine.close();

      const engine2 = await SqliteEngine.create(dbPath);
      // If migrations were tracked, opening the same DB again should not fail.
      engine2.index([makeEntry({ id: 'e1', name: 'tool' })]);
      const entry = engine2.getEntry('e1');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('tool');
      engine2.close();

      // Re-create engine for afterEach cleanup
      engine = await SqliteEngine.create(join(tempDir, 'test-cleanup.db'));
    });

    it('migrations are idempotent (opening twice does not fail)', async () => {
      const dbPath = join(tempDir, 'idem.db');
      const eng1 = await SqliteEngine.create(dbPath);
      eng1.index([makeEntry({ id: 'e1', name: 'first-run', tags: ['t1'] })]);
      eng1.close();

      const eng2 = await SqliteEngine.create(dbPath);
      eng2.index([makeEntry({ id: 'e2', name: 'second-run', tags: ['t2'] })]);

      const entry1 = eng2.getEntry('e2');
      expect(entry1).toBeDefined();
      expect(entry1!.name).toBe('second-run');
      eng2.close();
    });
  });

  // =========================================================================
  // Persistence (integration)
  // =========================================================================

  describe('Persistence', () => {
    it('data survives close and reopen', async () => {
      const dbPath = join(tempDir, 'persist.db');
      const eng1 = await SqliteEngine.create(dbPath);
      eng1.index([makeEntry({ id: 'e1', name: 'persistent-tool', tags: ['keep'] })]);
      eng1.toggleFavorite('e1');
      eng1.incrementUsage('e1');
      eng1.addTag('e1', 'user-tag');
      eng1.close();

      const eng2 = await SqliteEngine.create(dbPath);
      const entry = eng2.getEntry('e1');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('persistent-tool');
      expect(entry!.favorite).toBe(true);
      expect(entry!.usageCount).toBe(1);
      expect(entry!.tags).toContain('keep');
      expect(entry!.tags).toContain('user-tag');
      eng2.close();
    });
  });
});
