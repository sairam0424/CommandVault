import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchResult, SearchTier, VaultEntry } from '../types/index.js';
import { Vault } from '../vault.js';
import { withReadonlyDatabase } from './migration-fixtures.js';
import { buildSyntheticClaudeDir } from './synthetic-claude-dir.js';

// A favorite, a use or a tag recorded in this process has to show at once in getAllEntries() and
// on the fuse and minisearch tiers (the TUI and the bulk commands keep one Vault open), and it
// must never reach the scanned columns: the rows keep the parser tags, the user's tags stay in
// user_tags, and a rescan of an unchanged tree writes nothing.

const JS_TIERS: readonly SearchTier[] = ['fuse', 'minisearch'];
const LIMIT = 500;
const TAGGED_SKILL = 'tagged-skill';
/** A keyword the parser turns into a tag; the user may add and remove the same word as a user tag. */
const PARSER_TAG = 'shared';
const USER_TAG = 'mine2';
const SKILL_TO_MARK = 'code-review-0';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walBytes(dbPath: string): number {
  const wal = `${dbPath}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

function ids(results: readonly SearchResult[]): string[] {
  return results.map((result) => result.entry.id);
}

function entryNamed(vault: Vault, name: string): VaultEntry {
  const entry = vault.getAllEntries().find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no entry named ${name}`);
  return entry;
}

function entryById(vault: Vault, id: string): VaultEntry {
  const entry = vault.getAllEntries().find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no entry with id ${id}`);
  return entry;
}

function favoritesOn(vault: Vault, tier: SearchTier): string[] {
  return ids(vault.search({ query: '', favoritesOnly: true, tier, limit: LIMIT }));
}

function taggedOn(vault: Vault, tier: SearchTier, tag: string): string[] {
  return ids(vault.search({ query: '', tags: [tag], tier, limit: LIMIT }));
}

describe('a favorite, a use or a tag recorded while the vault is open', () => {
  let root: string;
  let claudeDir: string;
  let dbPath: string;
  let vault: Vault | null;

  async function openVault(): Promise<Vault> {
    const opened = new Vault({
      claudeConfigPath: claudeDir,
      dbPath,
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
    });
    await opened.initialize();
    return opened;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cv-user-state-mutations-'));
    claudeDir = join(root, 'claude');
    dbPath = join(root, 'data', 'vault.db');
    await buildSyntheticClaudeDir(claudeDir);
    // The hook parser stamps the scan time as last_modified, so a hook row is rewritten on every
    // scan (a defect of its own); the byte comparison below needs a tree a rescan leaves alone.
    rmSync(join(claudeDir, 'settings.json'));
    const skillDir = join(claudeDir, 'skills', TAGGED_SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${TAGGED_SKILL}\ndescription: Carries a parser tag\nkeywords: [${PARSER_TAG}]\n---\nBody.\n`,
    );
    vault = await openVault();
  });

  afterEach(async () => {
    await vault?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('shows a toggled favorite on the list and on both JavaScript tiers, and its removal', () => {
    const opened = vault!;
    const { id } = entryNamed(opened, SKILL_TO_MARK);
    for (const tier of JS_TIERS) expect(favoritesOn(opened, tier)).not.toContain(id);

    expect(opened.toggleFavorite(id)).toBe(true);

    expect(entryById(opened, id).favorite).toBe(true);
    for (const tier of JS_TIERS) expect(favoritesOn(opened, tier), tier).toContain(id);
    expect(ids(opened.quickSearch(SKILL_TO_MARK, 1))).toEqual([id]);
    expect(opened.quickSearch(SKILL_TO_MARK, 1)[0]?.entry.favorite).toBe(true);

    expect(opened.toggleFavorite(id)).toBe(false);

    expect(entryById(opened, id).favorite).toBe(false);
    for (const tier of JS_TIERS) expect(favoritesOn(opened, tier), tier).not.toContain(id);
  });

  it('counts every recorded use', () => {
    const opened = vault!;
    const { id } = entryNamed(opened, SKILL_TO_MARK);
    expect(entryById(opened, id).usageCount).toBe(0);

    opened.recordUsage(id);
    expect(entryById(opened, id).usageCount).toBe(1);

    opened.recordUsage(id);
    expect(entryById(opened, id).usageCount).toBe(2);
  });

  it('shows an added user tag, filters by it, and keeps a parser tag the user removes', () => {
    const opened = vault!;
    const { id, tags } = entryNamed(opened, TAGGED_SKILL);
    expect(tags).toContain(PARSER_TAG);
    for (const tier of JS_TIERS) expect(taggedOn(opened, tier, USER_TAG)).toEqual([]);

    opened.addTag(id, USER_TAG);

    expect(entryById(opened, id).tags).toEqual([...tags, USER_TAG]);
    for (const tier of JS_TIERS) expect(taggedOn(opened, tier, USER_TAG), tier).toEqual([id]);

    opened.addTag(id, PARSER_TAG);
    opened.removeTag(id, PARSER_TAG);

    expect(entryById(opened, id).tags).toContain(PARSER_TAG);
    expect(opened.getTagsForEntry(id)).toEqual([USER_TAG]);

    opened.removeTag(id, USER_TAG);

    expect(entryById(opened, id).tags).toEqual(tags);
    for (const tier of JS_TIERS) expect(taggedOn(opened, tier, USER_TAG), tier).toEqual([]);
  });

  it('survives a rescan and a reopen, and never reaches the scanned columns', async () => {
    const opened = vault!;
    const { id, tags } = entryNamed(opened, TAGGED_SKILL);
    opened.toggleFavorite(id);
    opened.recordUsage(id);
    opened.addTag(id, USER_TAG);

    await opened.scan();

    expect(entryById(opened, id)).toMatchObject({ favorite: true, usageCount: 1 });
    expect(entryById(opened, id).tags).toEqual([...tags, USER_TAG]);
    await opened.dispose();
    vault = null;
    const bytesAfterMarking = sha256(dbPath);
    expect(walBytes(dbPath)).toBe(0);

    const stored = withReadonlyDatabase(dbPath, (db) => ({
      tags: (db.prepare('SELECT tags FROM entries WHERE id = ?').get(id) as { tags: string }).tags,
      entryTags: (
        db.prepare('SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag').all(id) as {
          tag: string;
        }[]
      ).map((row) => row.tag),
      userTags: (
        db.prepare('SELECT tag FROM user_tags WHERE entry_id = ? ORDER BY tag').all(id) as {
          tag: string;
        }[]
      ).map((row) => row.tag),
    }));
    expect(stored.tags).toBe(tags.join(','));
    expect(stored.entryTags).toEqual([...tags].sort());
    expect(stored.userTags).toEqual([USER_TAG]);

    const reopened = await openVault();
    try {
      expect(entryById(reopened, id)).toMatchObject({ favorite: true, usageCount: 1 });
      expect(entryById(reopened, id).tags).toEqual([...tags, USER_TAG]);
    } finally {
      await reopened.dispose();
    }
    expect(sha256(dbPath)).toBe(bytesAfterMarking);
    expect(walBytes(dbPath)).toBe(0);
  });
});
