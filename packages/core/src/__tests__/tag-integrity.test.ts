import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import type { VaultEntry } from '../types/index.js';

function makeEntry(overrides: Partial<VaultEntry> & { id: string; name: string }): VaultEntry {
  return {
    type: 'skill',
    source: 'custom',
    description: '',
    filePath: '/test/' + overrides.name,
    tags: [],
    metadata: {},
    content: '',
    lastModified: new Date(),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

describe('Tag integrity — exact matching via junction table', () => {
  let engine: SqliteEngine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-tag-test-'));
    engine = new SqliteEngine(join(tempDir, 'test.db'));
  });

  afterEach(async () => {
    engine.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('exact tag "qa" does NOT match entry tagged only "squad"', () => {
    engine.index([
      makeEntry({ id: 'e1', name: 'squadTool', tags: ['squad', 'testing'] }),
      makeEntry({ id: 'e2', name: 'qaRunner', tags: ['qa', 'testing'] }),
    ]);

    const results = engine.search({ query: '', tags: ['qa'], limit: 50 });
    const names = results.map((r) => r.entry.name);

    expect(names).toContain('qaRunner');
    expect(names).not.toContain('squadTool');
  });

  it('exact tag "test" does NOT match "testing"', () => {
    engine.index([
      makeEntry({ id: 'e1', name: 'testing-tool', tags: ['testing'] }),
      makeEntry({ id: 'e2', name: 'test-runner', tags: ['test'] }),
    ]);

    const results = engine.search({ query: '', tags: ['test'], limit: 50 });
    const names = results.map((r) => r.entry.name);

    expect(names).toContain('test-runner');
    expect(names).not.toContain('testing-tool');
  });

  it('multiple tag filters require ALL tags to match', () => {
    engine.index([
      makeEntry({ id: 'e1', name: 'both', tags: ['qa', 'security'] }),
      makeEntry({ id: 'e2', name: 'qa-only', tags: ['qa'] }),
      makeEntry({ id: 'e3', name: 'sec-only', tags: ['security'] }),
    ]);

    const results = engine.search({ query: '', tags: ['qa', 'security'], limit: 50 });
    const names = results.map((r) => r.entry.name);

    expect(names).toContain('both');
    expect(names).not.toContain('qa-only');
    expect(names).not.toContain('sec-only');
  });

  it('tags are preserved after re-indexing', () => {
    const entries = [
      makeEntry({ id: 'e1', name: 'tool', tags: ['deploy', 'ci'] }),
    ];

    engine.index(entries);
    engine.index(entries);

    const results = engine.search({ query: '', tags: ['deploy'], limit: 50 });
    expect(results).toHaveLength(1);
    expect(results[0].entry.tags).toContain('deploy');
    expect(results[0].entry.tags).toContain('ci');
  });

  it('content-based snapshot hash detects content changes with same mtime', () => {
    const entry1 = makeEntry({
      id: 'e1',
      name: 'tool',
      content: 'version 1',
      lastModified: new Date('2025-01-01'),
    });

    engine.index([entry1]);
    engine.saveSnapshot([entry1]);

    const entry2 = { ...entry1, content: 'version 2' };
    engine.index([entry2]);

    const diff = engine.getDiff([entry2]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].name).toBe('tool');
  });
});
