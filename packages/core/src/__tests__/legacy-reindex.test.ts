import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../vault.js';
import {
  buildLegacyVault,
  hasLegacyUserTag,
  isLegacyFavorite,
  legacyIndex,
  legacyUsage,
  LEGACY_FILLER_TAG,
  LEGACY_USER_TAG,
  type LegacyVault,
} from './legacy-vault-fixture.js';
import { rowCounts, tableChecksums } from './migration-fixtures.js';

// The first scan after upgrading from 0.1.0: the tree a user has and the database 0.1.0 wrote for
// it. Every row is found again, nothing the user did to the rows is lost, and tag filtering works
// although the old database has no `entry_tags` rows: the rewrite of every row used to give them
// back on every scan, and a scan that leaves unchanged rows alone has to do it another way.

const ENTRY_COUNT = 60;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function openVault(fixture: LegacyVault): Promise<Vault> {
  const vault = new Vault({
    claudeConfigPath: fixture.claudeDir,
    dbPath: fixture.dbPath,
    enableWatcher: false,
    defaultSearchTier: 'sqlite',
  });
  await vault.initialize();
  return vault;
}

describe('the first scan of a vault written by 0.1.0', () => {
  let home: string;
  let fixture: LegacyVault;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cv-legacy-reindex-'));
    fixture = await buildLegacyVault(home, ENTRY_COUNT);
    expect(rowCounts(fixture.dbPath, ['entry_tags']).entry_tags).toBe(0);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('finds every entry again and rewrites none of them', async () => {
    const entriesBefore = tableChecksums(fixture.dbPath, ['entries']);

    const vault = await openVault(fixture);
    try {
      expect(vault.getAllEntries()).toHaveLength(fixture.counts.entries);
      expect(vault.getStats().totalEntries).toBe(fixture.counts.entries);
    } finally {
      await vault.dispose();
    }

    expect(rowCounts(fixture.dbPath, ['entries']).entries).toBe(fixture.counts.entries);
    expect(tableChecksums(fixture.dbPath, ['entries'])).toEqual(entriesBefore);
  });

  it('keeps every favorite, use count and user tag', async () => {
    const vault = await openVault(fixture);
    try {
      let favorites = 0;
      for (const seeded of fixture.entries) {
        const index = legacyIndex(seeded);
        const entry = vault.getEntry(seeded.id);
        expect(entry, seeded.name).toMatchObject({
          favorite: isLegacyFavorite(index),
          usageCount: legacyUsage(index),
        });
        if (hasLegacyUserTag(index)) expect(entry?.tags, seeded.name).toContain(LEGACY_USER_TAG);
        if (entry?.favorite) favorites += 1;
      }
      expect(favorites).toBe(fixture.counts.favorites);
      expect(vault.getStats().favoriteCount).toBe(fixture.counts.favorites);
    } finally {
      await vault.dispose();
    }
  });

  it('gives the rows their entry_tags back, so filtering by tag finds them', async () => {
    const vault = await openVault(fixture);
    try {
      const tagged = vault.search({
        query: '',
        tags: [LEGACY_FILLER_TAG],
        tier: 'sqlite',
        limit: ENTRY_COUNT * 2,
      });
      expect(tagged).toHaveLength(fixture.counts.entries);
    } finally {
      await vault.dispose();
    }

    expect(rowCounts(fixture.dbPath, ['entry_tags']).entry_tags).toBeGreaterThan(0);
  });

  it('is followed by a second scan that writes not a single byte', async () => {
    const first = await openVault(fixture);
    await first.dispose();
    const bytesBefore = sha256(fixture.dbPath);

    const second = await openVault(fixture);
    await second.dispose();

    expect(sha256(fixture.dbPath)).toBe(bytesBefore);
  });
});
