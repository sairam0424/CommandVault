import type { VaultEntry } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';

/**
 * The marks a user puts on entries (a favorite, a use, a tag of their own) live in the rows, never
 * in the files the parsers read, so a scan produces `favorite: false`, `usageCount: 0` and the
 * parser tags alone. This module reads the marks back and lays them over the scanned entries for
 * everything that shows entries: the Vault's list, the fuse tier and the minisearch tier.
 *
 * The scanned entries themselves are left as they are, on purpose: the sqlite tier compares them
 * with the scanned columns of the rows, so a user tag in that list would count as a change to every
 * tagged row on every scan and leak into the `tags` column. Only this module knows where the marks
 * live; a lane that moves them edits readUserState alone.
 */

export interface UserState {
  readonly favorites: ReadonlySet<string>;
  readonly usage: ReadonlyMap<string, number>;
  readonly userTags: ReadonlyMap<string, readonly string[]>;
}

interface MarkedRow {
  readonly id: string;
  readonly favorite: number;
  readonly usage_count: number;
}

interface UserTagRow {
  readonly entry_id: string;
  readonly tag: string;
}

/** One `IN (...)` list with its bindings; `null` stands for no restriction at all. */
interface IdList {
  readonly list: string | null;
  readonly params: Record<string, unknown>;
}

/** Ids per `IN (...)` list, well under SQLite's historical limit of 999 bound variables. */
const ID_LIST_CHUNK = 500;

function markedRowsSql(list: string | null): string {
  const scope = list === null ? '' : ` AND id IN (${list})`;
  return `SELECT id, favorite, usage_count FROM entries WHERE (favorite = 1 OR usage_count > 0)${scope}`;
}

function userTagRowsSql(list: string | null): string {
  const scope = list === null ? '' : ` WHERE entry_id IN (${list})`;
  return `SELECT entry_id, tag FROM user_tags${scope} ORDER BY entry_id, tag`;
}

/** Every row when `ids` is not given; otherwise one list per ID_LIST_CHUNK ids, none for no ids. */
function idLists(ids: readonly string[] | undefined): IdList[] {
  if (ids === undefined) return [{ list: null, params: {} }];
  const lists: IdList[] = [];
  for (let start = 0; start < ids.length; start += ID_LIST_CHUNK) {
    const chunk = ids.slice(start, start + ID_LIST_CHUNK);
    const params = Object.fromEntries(chunk.map((id, index) => [`$i${index}`, id]));
    lists.push({ list: Object.keys(params).join(', '), params });
  }
  return lists;
}

/**
 * The marks the rows hold right now, for `ids` or for every row: the favorites and use counts
 * from `entries`, the user's tags from `user_tags`. Two reads, no transaction, nothing written. A
 * row with no mark is not in the result.
 */
export function readUserState(conn: DatabaseAdapter, ids?: readonly string[]): UserState {
  const favorites = new Set<string>();
  const usage = new Map<string, number>();
  const userTags = new Map<string, readonly string[]>();

  for (const { list, params } of idLists(ids)) {
    for (const row of conn.queryAll<MarkedRow>(markedRowsSql(list), params)) {
      if (row.favorite === 1) favorites.add(row.id);
      if (row.usage_count > 0) usage.set(row.id, row.usage_count);
    }
    for (const row of conn.queryAll<UserTagRow>(userTagRowsSql(list), params)) {
      userTags.set(row.entry_id, [...(userTags.get(row.entry_id) ?? []), row.tag]);
    }
  }

  return { favorites, usage, userTags };
}

/**
 * `entries` with `state` laid over them: a new array in the same order. An entry whose marks differ
 * from what it carries becomes a new object with the row's `favorite` and `usageCount` and its tags
 * followed by the user's, each tag once and the parser tags first; an entry whose marks agree is
 * returned as it is. Neither the array nor any entry given is changed.
 */
export function applyUserState(
  entries: readonly VaultEntry[],
  state: UserState,
): readonly VaultEntry[] {
  return entries.map((entry) => withUserState(entry, state));
}

function withUserState(entry: VaultEntry, state: UserState): VaultEntry {
  const favorite = state.favorites.has(entry.id);
  const usageCount = state.usage.get(entry.id) ?? 0;
  const userTags = state.userTags.get(entry.id) ?? [];
  const tags = userTags.length === 0 ? entry.tags : [...new Set([...entry.tags, ...userTags])];
  const agrees =
    entry.favorite === favorite && entry.usageCount === usageCount && tags === entry.tags;
  return agrees ? entry : { ...entry, favorite, usageCount, tags };
}
