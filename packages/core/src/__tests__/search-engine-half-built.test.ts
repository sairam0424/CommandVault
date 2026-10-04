import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchEngine } from '../indexer/search-engine.js';
import type { VaultEntry } from '../types/index.js';

function makeEntry(id: string, name: string): VaultEntry {
  return {
    id,
    name,
    type: 'skill',
    source: 'custom',
    description: `${name} description`,
    filePath: `/fake/${name}.md`,
    tags: [],
    metadata: {},
    content: `${name} content`,
    lastModified: new Date('2025-01-01T00:00:00.000Z'),
    favorite: false,
    usageCount: 0,
  };
}

let tempDir: string;
let engine: SearchEngine;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cv-search-half-built-'));
  engine = await SearchEngine.create(join(tempDir, 'vault.db'), 'minisearch');
});

afterEach(async () => {
  engine.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe('SearchEngine: a failed MiniSearch build is never kept', () => {
  it('keeps failing on every query while the index holds duplicate ids, instead of answering from a partial index', () => {
    engine.index([
      makeEntry('same', 'alpha'),
      makeEntry('same', 'beta'),
      makeEntry('other', 'gamma'),
    ]);

    expect(() => engine.search({ query: 'alpha' })).toThrow(/duplicate/i);
    expect(() => engine.search({ query: 'gamma' })).toThrow(/duplicate/i);
    expect(() => engine.suggest('alp')).toThrow(/duplicate/i);
  });

  it('builds a working engine on the first query after the index is repaired', () => {
    engine.index([makeEntry('same', 'alpha'), makeEntry('same', 'beta')]);
    expect(() => engine.search({ query: 'alpha' })).toThrow(/duplicate/i);

    engine.index([makeEntry('one', 'alpha'), makeEntry('two', 'beta')]);

    expect(engine.search({ query: 'alpha' }).map((r) => r.entry.id)).toEqual(['one']);
  });
});
