import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseAdapter } from '../indexer/database-adapter.js';
import { createDatabaseAdapter } from '../indexer/database-factory.js';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';
import { applyUserState, readUserState, type UserState } from '../indexer/user-state.js';
import type { VaultEntry } from '../types/index.js';
import {
  FAVORITE_ID,
  USED_ID,
  createLegacyDatabase,
  withReadonlyDatabase,
} from './migration-fixtures.js';

// The user's own marks on the rows (favorite, usage_count, user_tags) read back as one value, and
// laid over the entries the parsers produced without touching them.

/** USED_ID's usage_count and FAVORITE_ID's user tag in the 0.1.0 sample (migration-fixtures.ts). */
const USED_COUNT = 3;
const USER_TAG = 'upgrade-test';
/** More ids than one `IN (...)` list holds, so the read has to split them. */
const BEYOND_ONE_CHUNK = 1200;

function makeEntry(id: string, tags: readonly string[]): VaultEntry {
  return {
    id,
    name: `entry-${id}`,
    type: 'skill',
    source: 'custom',
    description: `Entry ${id}`,
    filePath: `/fake/${id}.md`,
    tags,
    metadata: {},
    content: `Body of ${id}`,
    lastModified: new Date('2026-01-01T00:00:00Z'),
    favorite: false,
    usageCount: 0,
  };
}

describe.each<[string, (path: string) => Promise<DatabaseAdapter>]>([
  ['better-sqlite3', (path) => createDatabaseAdapter(path)],
  ['sql.js', (path) => SqlJsAdapter.create(path)],
])('readUserState on %s', (_backend, open) => {
  let dir: string;
  let dbPath: string;
  let conn: DatabaseAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cv-user-state-'));
    dbPath = join(dir, 'vault.db');
    createLegacyDatabase(dbPath);
    conn = await open(dbPath);
  });

  afterEach(async () => {
    conn.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the favorites, use counts and user tags the rows hold, and nothing else', () => {
    const state = readUserState(conn);

    expect([...state.favorites]).toEqual([FAVORITE_ID]);
    expect(state.usage.get(USED_ID)).toBe(USED_COUNT);
    expect(state.usage.has(FAVORITE_ID)).toBe(false);
    const usedRows = withReadonlyDatabase(dbPath, (db) =>
      db.prepare('SELECT id, usage_count FROM entries WHERE usage_count > 0').all(),
    ) as { id: string; usage_count: number }[];
    expect(new Map(state.usage)).toEqual(new Map(usedRows.map((row) => [row.id, row.usage_count])));
    expect([...state.userTags]).toEqual([[FAVORITE_ID, [USER_TAG]]]);
  });

  it('narrows to the given ids, however many there are', () => {
    const one = readUserState(conn, [USED_ID]);
    expect(one.favorites.size).toBe(0);
    expect([...one.usage]).toEqual([[USED_ID, USED_COUNT]]);
    expect(one.userTags.size).toBe(0);

    const none = readUserState(conn, []);
    expect(none.favorites.size + none.usage.size + none.userTags.size).toBe(0);

    const unknown = Array.from({ length: BEYOND_ONE_CHUNK }, (_, index) => `unknown-${index}`);
    const many = readUserState(conn, [...unknown, FAVORITE_ID, USED_ID]);
    expect([...many.favorites]).toEqual([FAVORITE_ID]);
    expect(many.usage.get(USED_ID)).toBe(USED_COUNT);
    expect(many.userTags.get(FAVORITE_ID)).toEqual([USER_TAG]);
  });
});

describe('applyUserState', () => {
  const entries: readonly VaultEntry[] = [
    makeEntry('a', ['x', 'y']),
    makeEntry('b', ['shared']),
    makeEntry('c', []),
  ];
  const state: UserState = {
    favorites: new Set(['a']),
    usage: new Map([['b', 4]]),
    userTags: new Map([['b', ['shared', 'mine']]]),
  };

  it('returns a new array in the same order and leaves the input array and objects untouched', () => {
    const before = structuredClone(entries);

    const shown = applyUserState(entries, state);

    expect(shown).not.toBe(entries);
    expect(shown.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(entries).toEqual(before);
    expect(entries.map((entry) => entry.tags)).toEqual(before.map((entry) => entry.tags));
  });

  it('gives an entry with state a new object that carries it', () => {
    const [favorite] = applyUserState(entries, state);

    expect(favorite).not.toBe(entries[0]);
    expect(favorite).toMatchObject({ id: 'a', favorite: true, usageCount: 0, tags: ['x', 'y'] });
  });

  it('puts the user tags after the parser tags, each tag once', () => {
    const [, used] = applyUserState(entries, state);

    expect(used).toMatchObject({ id: 'b', favorite: false, usageCount: 4 });
    expect(used?.tags).toEqual(['shared', 'mine']);
  });

  it('returns an entry without state as it is', () => {
    const [, , plain] = applyUserState(entries, state);

    expect(plain).toBe(entries[2]);
  });

  it('brings an entry that claims state the rows do not hold back to the rows', () => {
    const claimed = { ...makeEntry('d', ['t']), favorite: true, usageCount: 5 };

    const [shown] = applyUserState([claimed], state);

    expect(shown).toMatchObject({ id: 'd', favorite: false, usageCount: 0, tags: ['t'] });
    expect(claimed).toMatchObject({ favorite: true, usageCount: 5 });
  });
});
