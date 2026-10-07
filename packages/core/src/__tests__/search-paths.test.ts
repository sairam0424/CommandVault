import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchOptions } from '../types/index.js';
import { MAX_QUERY_TERMS, MAX_TERM_LENGTH } from '../indexer/search-query.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  CORPUS,
  CORPUS_BY_USAGE,
  DEPLOY_BY_LIKE_RANK,
  LONG_QUERY,
  MODIFIED_CUTOFF,
  entry,
  names,
  sortedNames,
} from './search-corpus.js';

// The sqlite tier answers a text query on one of two paths: fts5 when the build has the module and
// the table is healthy, LIKE over the same columns otherwise (the pure-JavaScript backend has no
// fts5 at all). Every behaviour a search has is run on both paths, the LIKE one on both backends.
// The module is hidden from the native build through the adapter, the way a build without it
// answers `pragma_module_list`; no SQL is faked.

type SearchPath = 'fts' | 'like-native' | 'like-sqljs';
const PATHS: readonly SearchPath[] = ['fts', 'like-native', 'like-sqljs'];

const scenario = vi.hoisted(() => ({
  path: 'fts' as SearchPath,
  queries: [] as string[],
  writes: [] as string[],
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  const { SqlJsAdapter } = await import('../indexer/sqljs-adapter.js');
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter =
        scenario.path === 'like-sqljs'
          ? await SqlJsAdapter.create(...args)
          : await original.createDatabaseAdapter(...args);
      return instrumentAdapter(adapter, {
        answerQuery: (sql) =>
          scenario.path === 'like-native' && /pragma_module_list/i.test(sql) ? [] : undefined,
        beforeQuery: (sql) => scenario.queries.push(sql),
        beforeExecute: (sql) => scenario.writes.push(sql),
        onTransaction: (options) => scenario.writes.push(`transaction ${options?.mode ?? ''}`),
      });
    },
  };
});

const MATCH_QUERY = /\bMATCH\b/;
const LIKE_QUERY = /\bLIKE\b/;

/** fts5 syntax typed by a user, and what reading it as words finds. */
const OPERATOR_QUERIES: Readonly<Record<string, readonly string[]>> = {
  'browse OR review': [],
  'browse NOT review': [],
  'browse AND review': [],
  'NEAR(browse': [],
  'name:browse': [],
  'brow*': ['browse'],
  '^review': ['review'],
};

/** Longer than any LIKE pattern SQLite takes (SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50000 bytes). */
const PASTED_TERM = 'a'.repeat(60_000);
/** The first letter of the Deseret block: a letter to both paths, four bytes in UTF-8. */
const DESERET_LONG_I = 0x10400;
/**
 * The longest query the terms allow in the widest letters, every term distinct. Each term starts
 * with a letter of its own that no other term has anywhere, so that `%term%` over an entry holding
 * the whole query matches at one place and fails on the first letter everywhere else: the test is
 * about the length of the patterns, not about scanning them.
 */
const WIDEST_QUERY = Array.from(
  { length: MAX_QUERY_TERMS },
  (_, index) =>
    `${String.fromCodePoint(DESERET_LONG_I + 1 + index)}${String.fromCodePoint(DESERET_LONG_I).repeat(MAX_TERM_LENGTH - 1)}`,
).join(' ');

describe.each(PATHS)('search on the sqlite tier, %s', (path) => {
  const fullText = path === 'fts';
  let tempDir: string;
  let engine: SqliteEngine;

  beforeEach(async () => {
    scenario.path = path;
    tempDir = await mkdtemp(join(tmpdir(), 'cv-search-paths-'));
    engine = await SqliteEngine.create(join(tempDir, 'vault.db'));
    engine.index(CORPUS);
    scenario.queries = [];
    scenario.writes = [];
  });

  afterEach(async () => {
    engine.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function search(options: Partial<SearchOptions> & { query: string }): string[] {
    return names(engine.search({ limit: 50, ...options }));
  }

  function found(options: Partial<SearchOptions> & { query: string }): string[] {
    return sortedNames(engine.search({ limit: 50, ...options }));
  }

  it('reports whether full-text search is on', () => {
    expect(engine.supportsFullTextSearch).toBe(fullText);
  });

  it('answers a text query on the path it reports, and writes nothing', () => {
    expect(search({ query: 'browse' })).toEqual(['browse']);

    expect(scenario.queries.some((sql) => MATCH_QUERY.test(sql))).toBe(fullText);
    expect(scenario.queries.some((sql) => LIKE_QUERY.test(sql))).toBe(!fullText);
    expect(scenario.writes).toEqual([]);
    expect(engine.supportsFullTextSearch).toBe(fullText);
  });

  it('lists every entry, most used first, for a query with nothing to search for', () => {
    for (const query of ['', '   ', '"', '*', '- -', '^', '""', '"*']) {
      scenario.queries = [];
      expect(search({ query })).toEqual(CORPUS_BY_USAGE);
      expect(
        scenario.queries.filter((sql) => MATCH_QUERY.test(sql) || LIKE_QUERY.test(sql)),
      ).toEqual([]);
    }
  });

  it('matches the name, the description, the content and the tags', () => {
    expect(search({ query: 'bmad' })).toEqual(['bmad-create-prd']);
    expect(search({ query: 'OWASP' })).toEqual(['security-scan']);
    expect(search({ query: 'camelCase' })).toEqual(['coding style']);
    expect(search({ query: 'planning' })).toEqual(['bmad-create-prd']);
  });

  it('keeps the hyphens and colons of a term', () => {
    expect(found({ query: 'security-scan' })).toEqual(['security-scan', 'security-scan-report']);
    expect(search({ query: 'bmad-create-prd' })).toEqual(['bmad-create-prd']);
    expect(search({ query: 'PreToolUse:Bash:guard' })).toEqual(['PreToolUse:Bash:guard']);
  });

  it('survives a lone, an unbalanced and an embedded quote', () => {
    const withScan = ['scan security', 'security-scan', 'security-scan-report'];
    expect(search({ query: '"' })).toEqual(CORPUS_BY_USAGE);
    expect(found({ query: '"scan' })).toEqual(withScan);
    expect(found({ query: 'scan"' })).toEqual(withScan);
    expect(search({ query: 'secu"rity' })).toEqual([]);
    expect(search({ query: "it's" })).toEqual(['café notes']);
  });

  it('finds unicode text', () => {
    expect(search({ query: 'café' })).toEqual(['café notes']);
    expect(search({ query: '日本語' })).toEqual(['café notes']);
  });

  it('requires every term: terms are joined by AND, never OR', () => {
    expect(search({ query: 'security owasp' })).toEqual(['security-scan']);
    expect(search({ query: 'browse review' })).toEqual([]);
    expect(search({ query: 'security zzznothing' })).toEqual([]);
  });

  it('takes fts5 operators and column filters typed by a user as words, on the path it reports', () => {
    for (const [query, expected] of Object.entries(OPERATOR_QUERIES)) {
      expect(search({ query }), query).toEqual(expected);
    }

    // None of them was taken for a lost table: every one was answered on the path reported.
    expect(engine.supportsFullTextSearch).toBe(fullText);
    expect(scenario.queries.filter((sql) => MATCH_QUERY.test(sql))).toHaveLength(
      fullText ? Object.keys(OPERATOR_QUERIES).length : 0,
    );
  });

  it('answers a pasted term longer than any LIKE pattern with nothing, and finds the widest query', () => {
    expect(search({ query: PASTED_TERM })).toEqual([]);
    expect(search({ query: WIDEST_QUERY })).toEqual([]);
    // The patterns of the LIKE rank are only evaluated for a row every term matches: the entry that
    // holds the whole widest query is what runs them, and the widest pattern, through SQLite.
    engine.index([...CORPUS, entry('widest', { content: WIDEST_QUERY })]);
    expect(search({ query: WIDEST_QUERY })).toEqual(['widest']);
    expect(engine.supportsFullTextSearch).toBe(fullText);
  });

  it('takes %, _ and \\ in a term literally', () => {
    expect(search({ query: 'cache_warm' })).toEqual(['cache_warm']);
    expect(search({ query: 'pct%done' })).toEqual(['pct%done']);
    expect(search({ query: 'back\\slash' })).toEqual(['back\\slash']);
  });

  it('ignores ASCII case', () => {
    expect(found({ query: 'DEPLOY' })).toEqual(found({ query: 'deploy' }));
    expect(found({ query: 'Security-Scan' })).toEqual(['security-scan', 'security-scan-report']);
  });

  it('applies the filters together with a text query', () => {
    engine.addTag('review', 'mine');

    expect(search({ query: 'deploy', type: 'hook' })).toEqual(['deploy-hook']);
    expect(search({ query: 'review', source: 'gstack' })).toEqual(['review']);
    expect(search({ query: 'review', source: 'bmad' })).toEqual([]);
    expect(search({ query: 'review', tags: ['mine'] })).toEqual(['review']);
    expect(search({ query: 'browse', tags: ['mine'] })).toEqual([]);
    expect(search({ query: 'review', tags: ['code'] })).toEqual(['review']);
    expect(search({ query: 'e', favoritesOnly: true })).toEqual(['browse']);
    expect(search({ query: 'review', modifiedBefore: MODIFIED_CUTOFF })).toEqual(['review']);
    expect(search({ query: 'review', modifiedAfter: MODIFIED_CUTOFF })).toEqual([]);
  });

  it('pages with limit and offset', () => {
    const pages = [0, 2, 4].map((offset) => search({ query: 'deploy', limit: 2, offset }));

    expect(pages.map((page) => page.length)).toEqual([2, 2, 2]);
    expect(pages.flat().sort()).toEqual([...DEPLOY_BY_LIKE_RANK].sort());
    expect(search({ query: 'deploy', limit: 2, offset: 6 })).toEqual([]);
  });

  it('answers a query of many terms', () => {
    expect(search({ query: LONG_QUERY })).toEqual(['longform']);
  });

  if (fullText) {
    it('returns every entry that has every term, ranked by fts5', () => {
      expect(found({ query: 'deploy' })).toEqual([...DEPLOY_BY_LIKE_RANK].sort());
    });
  } else {
    it('ranks a name that is the query over a prefix, a word, the description and the content', () => {
      expect(search({ query: 'deploy' })).toEqual(DEPLOY_BY_LIKE_RANK);
    });

    it('ranks a name of several words that is the query first, however its words are joined', () => {
      expect(search({ query: 'security scan' })).toEqual([
        'security-scan',
        'security-scan-report',
        'scan security',
      ]);
      expect(search({ query: 'cache warm' })).toEqual(['cache_warm', 'cacheXwarm']);
    });
  }
});
