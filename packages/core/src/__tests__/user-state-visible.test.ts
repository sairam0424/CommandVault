import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchTier } from '../types/index.js';
import { Vault } from '../vault.js';
import {
  buildLegacyVault,
  hasLegacyUserTag,
  isLegacyFavorite,
  legacyIndex,
  legacyName,
  legacyUsage,
  LEGACY_USER_TAG,
  type LegacyVault,
} from './legacy-vault-fixture.js';

// A vault whose rows carry favorites, use counts and user tags (here: written by 0.1.0, the same
// for every mark made by an earlier process). Every listing and every search tier has to show
// them: `list`, `export`, `stats`, `info` and the TUI read getAllEntries() or the fuse tier, and
// `list --favorites` printed nothing after `favorite` had succeeded (RC-DATA-05, CV-G1-004).

const ENTRY_COUNT = 60;
const LIMIT = ENTRY_COUNT * 2;
const TIERS: readonly SearchTier[] = ['fuse', 'minisearch', 'sqlite'];
/** Index 0: a favorite, used once, tagged by the user; every tier must say so. */
const MARKED_INDEX = 0;

describe('favorites, use counts and user tags held by the rows', () => {
  let home: string;
  let fixture: LegacyVault;
  let vault: Vault;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'cv-user-state-visible-'));
    fixture = await buildLegacyVault(home, ENTRY_COUNT);
    vault = new Vault({
      claudeConfigPath: fixture.claudeDir,
      dbPath: fixture.dbPath,
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
    });
    await vault.initialize();
  });

  afterAll(async () => {
    await vault.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('are on every entry getAllEntries() lists', () => {
    const entries = vault.getAllEntries();

    expect(entries).toHaveLength(fixture.counts.entries);
    for (const entry of entries) {
      const index = legacyIndex(entry);
      expect(entry.favorite, entry.name).toBe(isLegacyFavorite(index));
      expect(entry.usageCount, entry.name).toBe(legacyUsage(index));
      expect(entry.tags.includes(LEGACY_USER_TAG), entry.name).toBe(hasLegacyUserTag(index));
    }
  });

  it('come with a listing in name order, not in the order of the id hashes', () => {
    const names = vault.getAllEntries().map((entry) => entry.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('are on the entry quickSearch() finds, the way the info and favorite commands look it up', () => {
    const [found] = vault.quickSearch(legacyName(MARKED_INDEX), 1);

    expect(found?.entry).toMatchObject({
      name: legacyName(MARKED_INDEX),
      favorite: true,
      usageCount: legacyUsage(MARKED_INDEX),
    });
    expect(found?.entry.tags).toContain(LEGACY_USER_TAG);
  });

  it.each(TIERS)('filter the favorites on the %s tier without a query', (tier) => {
    const results = vault.search({ query: '', favoritesOnly: true, tier, limit: LIMIT });

    expect(results).toHaveLength(fixture.counts.favorites);
    expect(results.every((result) => result.entry.favorite)).toBe(true);
  });

  it.each(TIERS)('filter by a user tag on the %s tier without a query', (tier) => {
    const results = vault.search({ query: '', tags: [LEGACY_USER_TAG], tier, limit: LIMIT });

    expect(results).toHaveLength(fixture.counts.userTagged);
    expect(results.every((result) => result.entry.tags.includes(LEGACY_USER_TAG))).toBe(true);
  });

  it.each(TIERS)('filter the favorites on the %s tier with a query', (tier) => {
    const results = vault.search({ query: 'legacy', favoritesOnly: true, tier, limit: LIMIT });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.entry.favorite)).toBe(true);
  });
});
