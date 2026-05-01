import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Vault, createVault } from '../vault.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const HAS_CLAUDE_DIR = existsSync(CLAUDE_DIR);

describe.skipIf(!HAS_CLAUDE_DIR)('Integration: Vault against real ~/.claude', () => {
  let vault: Vault;
  let tempDbDir: string;

  beforeAll(async () => {
    tempDbDir = await mkdtemp(join(tmpdir(), 'commandvault-test-'));
    vault = createVault({
      claudeConfigPath: CLAUDE_DIR,
      dbPath: join(tempDbDir, 'vault.db'),
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
    });
    await vault.initialize();
  });

  afterAll(async () => {
    await vault.dispose();
    await rm(tempDbDir, { recursive: true, force: true });
  });

  it('indexes a significant number of entries (>200)', () => {
    const entries = vault.getAllEntries();
    expect(entries.length).toBeGreaterThan(200);
  });

  it('contains entries of common types (skill, command, rule, hook)', () => {
    const types = new Set(vault.getAllEntries().map((e) => e.type));
    expect(types.has('skill')).toBe(true);
    expect(types.has('command')).toBe(true);
    expect(types.has('rule')).toBe(true);
    expect(types.has('hook')).toBe(true);
    // agent and plugin may not be present depending on the user's config
  });

  it('search returns results for "review"', () => {
    const results = vault.search({ query: 'review' });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.entry.name);
    expect(names.some((n) => n.toLowerCase().includes('review'))).toBe(true);
  });

  it('quickSearch returns results for "browse"', () => {
    const results = vault.quickSearch('browse');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.name).toBe('browse');
  });

  it('getEntriesByType returns only the requested type', () => {
    const skills = vault.getEntriesByType('skill');
    expect(skills.length).toBeGreaterThan(0);
    skills.forEach((s) => {
      expect(s.type).toBe('skill');
    });

    const rules = vault.getEntriesByType('rule');
    expect(rules.length).toBeGreaterThan(0);
    rules.forEach((r) => {
      expect(r.type).toBe('rule');
    });
  });

  it('getEntriesBySource returns only the requested source', () => {
    const gstackEntries = vault.getEntriesBySource('gstack');
    expect(gstackEntries.length).toBeGreaterThan(0);
    gstackEntries.forEach((e) => {
      expect(e.source).toBe('gstack');
    });
  });

  it('getStats returns valid VaultStats', () => {
    const stats = vault.getStats();
    expect(stats.totalEntries).toBeGreaterThan(200);
    expect(stats.byType).toBeDefined();
    // Only assert types that are guaranteed to exist; others may be absent
    // depending on the user's local ~/.claude configuration
    const typeEntries = Object.entries(stats.byType);
    expect(typeEntries.length).toBeGreaterThan(0);
    for (const [typeName, count] of typeEntries) {
      expect(typeof typeName).toBe('string');
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThan(0);
    }
    expect(stats.bySource).toBeDefined();
    expect(typeof stats.favoriteCount).toBe('number');
    expect(stats.lastScanAt).toBeInstanceOf(Date);
  });

  it('getStats byType counts sum to totalEntries', () => {
    const stats = vault.getStats();
    const typeSum = Object.values(stats.byType).reduce((sum, n) => sum + n, 0);
    expect(typeSum).toBe(stats.totalEntries);
  });

  it('suggest returns autocompletion candidates', () => {
    const suggestions = vault.suggest('brow');
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('every entry has required fields populated', () => {
    const entries = vault.getAllEntries();
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.type).toBeTruthy();
      expect(entry.source).toBeTruthy();
      expect(entry.filePath).toBeTruthy();
      expect(entry.lastModified).toBeInstanceOf(Date);
      expect(typeof entry.favorite).toBe('boolean');
      expect(typeof entry.usageCount).toBe('number');
    }
  });

  it('getEntry retrieves a specific entry by id', () => {
    const allEntries = vault.getAllEntries();
    const sampleId = allEntries[0].id;
    const entry = vault.getEntry(sampleId);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(sampleId);
  });

  it('search with type filter narrows results', () => {
    const allResults = vault.search({ query: 'test' });
    const skillResults = vault.search({ query: 'test', type: 'skill' });
    skillResults.forEach((r) => {
      expect(r.entry.type).toBe('skill');
    });
    // Filtered results should be a subset
    expect(skillResults.length).toBeLessThanOrEqual(allResults.length);
  });
});
