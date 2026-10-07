import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import {
  CORPUS,
  PARITY_QUERIES,
  PARITY_QUERIES_FINDING_NOTHING,
  PATH_DIVERGENCES,
  sortedNames,
} from './search-corpus.js';

// Whether a vault is searched with fts5 or with LIKE should not change what a query finds, only how
// it is ordered: a user of the VS Code extension (sql.js, no fts5) and a user of the CLI (native
// build, fts5) type the same queries into the same vault. For every representative query the
// three ways of answering it (fts5; LIKE on the native build with the module hidden; LIKE on the
// pure-JavaScript backend) return the same set of entries. Where the paths do differ (a term is a
// token prefix on fts5 and a substring on LIKE) the difference is pinned, so it cannot widen.

const QUERIES = [...PARITY_QUERIES, ...PATH_DIVERGENCES.map(({ query }) => query)];

type SearchPath = 'fts' | 'like-native' | 'like-sqljs';
const PATHS: readonly SearchPath[] = ['fts', 'like-native', 'like-sqljs'];

const scenario = vi.hoisted(() => ({ path: 'fts' as SearchPath }));

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
      });
    },
  };
});

type Answers = ReadonlyMap<string, readonly string[]>;

async function answersOn(path: SearchPath, dir: string): Promise<Answers> {
  scenario.path = path;
  const engine = await SqliteEngine.create(join(dir, 'vault.db'));
  try {
    engine.index(CORPUS);
    expect(engine.supportsFullTextSearch).toBe(path === 'fts');
    const answers = new Map(
      QUERIES.map((query) => [query, sortedNames(engine.search({ query, limit: 50 }))]),
    );
    // Every query was answered on this path: none was taken for a lost table.
    expect(engine.supportsFullTextSearch).toBe(path === 'fts');
    return answers;
  } finally {
    engine.close();
  }
}

describe('the full-text path and the LIKE path find the same entries', () => {
  let tempDir: string;
  const answers = new Map<SearchPath, Answers>();

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-search-parity-'));
    for (const path of PATHS) {
      answers.set(path, await answersOn(path, join(tempDir, path)));
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each(
    PARITY_QUERIES.map((query) => [query.length > 40 ? `${query.slice(0, 37)}...` : query, query]),
  )('for %j', (_label, query) => {
    const byFts = answers.get('fts')?.get(query);
    expect(byFts).toBeDefined();
    expect(answers.get('like-native')?.get(query)).toEqual(byFts);
    expect(answers.get('like-sqljs')?.get(query)).toEqual(byFts);
  });

  it('finds something for every query but the operator ones, so the parity is not between empty sets', () => {
    const byFts = answers.get('fts');
    const empty = PARITY_QUERIES.filter((query) => byFts?.get(query)?.length === 0);
    expect(empty).toEqual(PARITY_QUERIES_FINDING_NOTHING);
  });

  it.each(PATH_DIVERGENCES.map((divergence) => [divergence.query, divergence]))(
    'differ, as pinned, for %j',
    (_label, { query, fts, like, because }) => {
      expect(answers.get('fts')?.get(query), because).toEqual(fts);
      expect(answers.get('like-native')?.get(query), because).toEqual(like);
      expect(answers.get('like-sqljs')?.get(query), because).toEqual(like);
    },
  );
});
