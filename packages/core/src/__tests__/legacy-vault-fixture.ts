import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import type { VaultEntry } from '../types/index.js';
import { parseAgents, parseCommands, parseSkills } from '../parsers/index.js';
import { createLegacyDatabase } from './migration-fixtures.js';

/**
 * A vault the size of the maintainer's (998 entries, counted on a copy of their pre-remediation
 * vault.db) as a 0.1.0 user left it: a `~/.claude`-shaped tree of skills, commands and agents with
 * deterministic contents, and the database the published 0.1.0 wrote for it (schema 1-2, legacy
 * full-text table and triggers), with a favorite on every 7th entry, uses on every 5th, a user tag
 * on every 11th. The rows are what this build's own parsers produce for the tree, so the first scan
 * after the upgrade finds every id again (0 prunes) and no column to rewrite.
 *
 * `entry_tags` is left empty, the shape of a vault whose table came with migration 1 after the rows
 * were written (the published 0.1.0 itself did fill it): until now the rewrite of every row on every
 * scan gave the rows back silently, and `--tag` filtering on an upgraded vault depends on them.
 *
 * Also runnable: node dist/__tests__/legacy-vault-fixture.js <home> [count] prints the count written,
 * for a CLI started with HOME=<home> (never the real one).
 */

export const DEFAULT_LEGACY_ENTRY_COUNT = 998;
export const LEGACY_FILLER_TAG = 'filler';
export const LEGACY_USER_TAG = 'mine';
const FAVORITE_EVERY = 7;
const USED_EVERY = 5;
const USER_TAGGED_EVERY = 11;
const USAGE_SPREAD = 3;
const TOPIC_COUNT = 5;
const ENTRY_TYPES = ['skill', 'command', 'agent'] as const;
const DATA_DIR = '.commandvault';
const CLAUDE_DIR = '.claude';

type LegacyType = (typeof ENTRY_TYPES)[number];

export interface LegacyVaultCounts {
  readonly entries: number;
  readonly favorites: number;
  readonly used: number;
  readonly userTagged: number;
  readonly byType: Readonly<Record<LegacyType, number>>;
}

export interface LegacyVault {
  readonly claudeDir: string;
  readonly dbPath: string;
  /** The parsed entries the rows were written from, in id order, with the state the rows carry. */
  readonly entries: readonly VaultEntry[];
  readonly counts: LegacyVaultCounts;
}

function countMultiples(count: number, every: number): number {
  return count === 0 ? 0 : Math.floor((count - 1) / every) + 1;
}

export function expectedCounts(count = DEFAULT_LEGACY_ENTRY_COUNT): LegacyVaultCounts {
  const byType = { skill: 0, command: 0, agent: 0 };
  for (let index = 0; index < count; index += 1) byType[legacyType(index)] += 1;
  return {
    entries: count,
    favorites: countMultiples(count, FAVORITE_EVERY),
    used: countMultiples(count, USED_EVERY),
    userTagged: countMultiples(count, USER_TAGGED_EVERY),
    byType,
  };
}

export function legacyType(index: number): LegacyType {
  return ENTRY_TYPES[index % ENTRY_TYPES.length]!;
}

export function legacyName(index: number): string {
  return `legacy-${legacyType(index)}-${index}`;
}

export function isLegacyFavorite(index: number): boolean {
  return index % FAVORITE_EVERY === 0;
}

export function legacyUsage(index: number): number {
  return index % USED_EVERY === 0 ? 1 + (index % USAGE_SPREAD) : 0;
}

export function hasLegacyUserTag(index: number): boolean {
  return index % USER_TAGGED_EVERY === 0;
}

/** The index an entry was generated with, from its name. */
export function legacyIndex(entry: Pick<VaultEntry, 'name'>): number {
  return Number(entry.name.slice(entry.name.lastIndexOf('-') + 1));
}

function markdown(index: number): string {
  const name = legacyName(index);
  return [
    '---',
    `name: ${name}`,
    `description: Legacy ${legacyType(index)} number ${index} about topic ${index % TOPIC_COUNT}`,
    `keywords: [${LEGACY_FILLER_TAG}, topic-${index % TOPIC_COUNT}]`,
    '---',
    `Body of ${name}, written by a 0.1.0 user. Lorem ipsum ${index}.`,
    '',
  ].join('\n');
}

function relativePath(index: number): string {
  const name = legacyName(index);
  switch (legacyType(index)) {
    case 'skill':
      return join('skills', name, 'SKILL.md');
    case 'command':
      return join('commands', `${name}.md`);
    case 'agent':
      return join('agents', `${name}.md`);
  }
}

/** The `~/.claude`-shaped tree alone, for a database another writer produces (the published 0.1.0). */
export function writeLegacyTree(claudeDir: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const path = join(claudeDir, relativePath(index));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, markdown(index));
  }
}

/** What `Vault.scan` would produce for the tree: the same parsers, sorted by id the same way. */
async function parseTree(claudeDir: string): Promise<VaultEntry[]> {
  const results = await Promise.all([
    parseSkills(join(claudeDir, 'skills')),
    parseCommands(join(claudeDir, 'commands')),
    parseAgents(join(claudeDir, 'agents')),
  ]);
  const errors = results.flatMap((result) => result.errors);
  if (errors.length > 0) {
    throw new Error(`legacy fixture tree did not parse cleanly: ${errors[0]!.message}`);
  }
  return results
    .flatMap((result) => result.entries)
    .map((entry) => withLegacyState(entry))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function withLegacyState(entry: VaultEntry): VaultEntry {
  const index = legacyIndex(entry);
  return { ...entry, favorite: isLegacyFavorite(index), usageCount: legacyUsage(index) };
}

function insertRows(db: Database.Database, entries: readonly VaultEntry[]): void {
  const insert = db.prepare(
    `INSERT INTO entries (id, name, type, source, description, file_path, tags, metadata, content,
       last_modified, favorite, usage_count)
     VALUES (@id, @name, @type, @source, @description, @filePath, @tags, @metadata, @content,
       @lastModified, @favorite, @usageCount)`,
  );
  const tagUser = db.prepare('INSERT INTO user_tags (entry_id, tag) VALUES (?, ?)');
  for (const entry of entries) {
    insert.run({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      source: entry.source,
      description: entry.description,
      filePath: entry.filePath,
      tags: entry.tags.join(','),
      metadata: JSON.stringify(entry.metadata),
      content: entry.content,
      lastModified: entry.lastModified.toISOString(),
      favorite: entry.favorite ? 1 : 0,
      usageCount: entry.usageCount,
    });
    if (hasLegacyUserTag(legacyIndex(entry))) tagUser.run(entry.id, LEGACY_USER_TAG);
  }
}

/** Writes `<home>/.claude` and `<home>/.commandvault/vault.db`; `home` must be a throwaway one. */
export async function buildLegacyVault(
  home: string,
  count = DEFAULT_LEGACY_ENTRY_COUNT,
): Promise<LegacyVault> {
  const claudeDir = join(home, CLAUDE_DIR);
  const dbPath = join(home, DATA_DIR, 'vault.db');
  writeLegacyTree(claudeDir, count);
  const entries = await parseTree(claudeDir);
  if (entries.length !== count) {
    throw new Error(`legacy fixture: wrote ${count} files, parsed ${entries.length} entries`);
  }
  mkdirSync(join(home, DATA_DIR), { recursive: true });
  createLegacyDatabase(dbPath, (db) => insertRows(db, entries));
  return { claudeDir, dbPath, entries, counts: expectedCounts(count) };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [home, countText] = process.argv.slice(2);
  if (!home) {
    process.stderr.write('usage: legacy-vault-fixture.js <throwaway home> [count]\n');
    process.exit(64);
  }
  const vault = await buildLegacyVault(home, countText ? Number(countText) : undefined);
  process.stdout.write(`${vault.counts.entries}\n`);
}
