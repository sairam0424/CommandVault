import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from '../vault.js';
import {
  expectedCounts,
  hasLegacyUserTag,
  isLegacyFavorite,
  legacyIndex,
  legacyUsage,
  writeLegacyTree,
  LEGACY_FILLER_TAG,
  LEGACY_USER_TAG,
} from './legacy-vault-fixture.js';
import { engineMeta, recordedVersions, rowCounts, CURRENT_VERSIONS } from './migration-fixtures.js';

// fixtures/vault-0.1.0-generated.sqlite was written by the PUBLISHED @commandvault/core@0.1.0 (its own
// better-sqlite3 11.10.0, built for Node 22; SQLite 3.49.2) over the 36-entry tree writeLegacyTree
// produces, with the fixture's favorite, use and user-tag rules applied through 0.1.0's Vault API,
// then a snapshot. Schema 1-2, external-content full-text table with its three triggers, WAL mode,
// 94,208 bytes. The ids 0.1.0 wrote are the ids this build's parsers produce (both hash
// type:name:source), so the upgrade must find every row again.

const FIXTURE_DB = fileURLToPath(
  new URL('./fixtures/vault-0.1.0-generated.sqlite', import.meta.url),
);
const ENTRY_COUNT = 36;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('upgrading a vault the published 0.1.0 wrote', () => {
  let home: string;
  let claudeDir: string;
  let dbPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cv-legacy-0-1-0-'));
    claudeDir = join(home, '.claude');
    dbPath = join(home, '.commandvault', 'vault.db');
    writeLegacyTree(claudeDir, ENTRY_COUNT);
    mkdirSync(join(home, '.commandvault'));
    copyFileSync(FIXTURE_DB, dbPath);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function openVault(): Promise<Vault> {
    const vault = new Vault({
      claudeConfigPath: claudeDir,
      dbPath,
      enableWatcher: false,
      defaultSearchTier: 'sqlite',
    });
    await vault.initialize();
    return vault;
  }

  it('finds every entry 0.1.0 indexed and keeps what the user did to them', async () => {
    const counts = expectedCounts(ENTRY_COUNT);
    const vault = await openVault();
    try {
      const entries = vault.getAllEntries();
      expect(entries).toHaveLength(counts.entries);
      for (const scanned of entries) {
        const index = legacyIndex(scanned);
        const stored = vault.getEntry(scanned.id);
        expect(stored, scanned.name).toMatchObject({
          favorite: isLegacyFavorite(index),
          usageCount: legacyUsage(index),
        });
        if (hasLegacyUserTag(index)) expect(stored?.tags, scanned.name).toContain(LEGACY_USER_TAG);
      }
      expect(vault.getStats().favoriteCount).toBe(counts.favorites);
      expect(
        vault.search({ query: '', tags: [LEGACY_FILLER_TAG], tier: 'sqlite', limit: 100 }),
      ).toHaveLength(counts.entries);
    } finally {
      await vault.dispose();
    }

    expect(rowCounts(dbPath, ['entries']).entries).toBe(counts.entries);
    expect(recordedVersions(dbPath)).toEqual(CURRENT_VERSIONS);
    expect(engineMeta(dbPath).fts_state).toBe('ready');
  });

  it('writes nothing on the scan after the upgrade', async () => {
    const first = await openVault();
    await first.dispose();
    const bytesBefore = sha256(dbPath);

    const second = await openVault();
    await second.dispose();

    expect(sha256(dbPath)).toBe(bytesBefore);
  });
});
