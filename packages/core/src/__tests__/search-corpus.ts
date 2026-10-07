import type { SearchResult, VaultEntry } from '../types/index.js';

/**
 * The corpus every sqlite search path is tested on (search-paths, search-parity,
 * search-fts-fallback). Ids are the names, so a result list reads as the names it holds. Each
 * entry is there for a query: hyphens and colons in names, an apostrophe and unicode letters, the
 * look-alike pairs a LIKE pattern left unescaped would confuse, the entries that spell out the
 * LIKE rank, and one whose content is a query of many terms.
 */

const DEFAULT_MODIFIED = new Date(Date.UTC(2026, 0, 1));
/** Older than every other entry: the `modifiedAfter` / `modifiedBefore` tests cut here. */
export const OLD_MODIFIED = new Date(Date.UTC(2024, 0, 1));
export const MODIFIED_CUTOFF = new Date(Date.UTC(2025, 0, 1));

/** More terms than the engine keeps; the one entry whose content holds them all. */
export const LONG_QUERY_WORDS = 100;
export const LONG_QUERY = Array.from({ length: LONG_QUERY_WORDS }, (_, index) => `w${index}`).join(
  ' ',
);

/** A corpus entry: its id is its name, every other field has a quiet default. */
export function entry(name: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: name,
    name,
    type: 'skill',
    source: 'custom',
    description: '',
    filePath: `/corpus/${name}/SKILL.md`,
    tags: [],
    metadata: {},
    content: '',
    lastModified: DEFAULT_MODIFIED,
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

export const CORPUS: readonly VaultEntry[] = [
  entry('browse', {
    source: 'gstack',
    description: 'Headless browser for QA testing',
    tags: ['browser', 'qa', 'testing'],
    content: 'Navigate URLs and interact with elements',
    usageCount: 42,
    favorite: true,
  }),
  entry('review', {
    source: 'gstack',
    description: 'Pre-landing PR review for code quality',
    tags: ['review', 'code'],
    content: 'Analyze diff for SQL safety and trust boundaries',
    usageCount: 30,
    lastModified: OLD_MODIFIED,
  }),
  entry('bmad-create-prd', {
    source: 'bmad',
    description: 'Create a product requirements document',
    tags: ['planning', 'prd'],
    content: 'Guided PRD creation with requirements discovery',
    usageCount: 15,
  }),
  entry('security-scan', {
    type: 'command',
    source: 'mindforge',
    description: 'Run OWASP security scan on changed files',
    tags: ['security', 'owasp'],
    content: 'Scans for vulnerabilities',
    usageCount: 20,
  }),
  entry('PreToolUse:Bash:guard', {
    type: 'hook',
    description: 'PreToolUse hook on Bash for destructive command guard',
    tags: ['hook', 'pretooluse', 'bash'],
    content: '// guard script',
    usageCount: 100,
  }),
  // Two more used than `security-scan` that the query "security scan" also finds: one that starts
  // with its words (the prefix tier) and one that has them in the other order (the word tier).
  // The exact tier, compared word for word, must still put `security-scan` first.
  entry('security-scan-report', { description: 'noise', usageCount: 60 }),
  entry('scan security', { description: 'noise', usageCount: 50 }),
  entry('coding style', {
    type: 'rule',
    description: 'Enforce coding style rules for the project',
    tags: ['rule', 'style'],
    content: 'Use camelCase for variables',
  }),
  entry('café notes', {
    description: "it's a café guide",
    tags: ['unicode'],
    content: 'unicode 日本語 text about coffee',
  }),
  // Look-alike pairs: a LIKE pattern that is not escaped matches both of each pair.
  entry('cache_warm', { description: 'Warm the cache, with an underscore' }),
  entry('cacheXwarm', { description: 'Looks alike without the underscore' }),
  entry('pct%done', { description: 'Percent sign in a name' }),
  entry('pctXdone', { description: 'Looks alike without the percent sign' }),
  entry('back\\slash', { description: 'Backslash in a name' }),
  entry('backslash', { description: 'Looks alike without the backslash' }),
  // The LIKE rank for "deploy": usage runs against the rank, so the order can only come from it.
  entry('deploy', { usageCount: 0 }),
  entry('deploy-hook', { type: 'hook', description: 'hook', usageCount: 1 }),
  entry('auto deploy', { description: 'automation', usageCount: 2 }),
  entry('runner', { description: 'deploy things', usageCount: 3 }),
  entry('another', { description: 'noise', content: 'we deploy too', usageCount: 9 }),
  entry('other', { description: 'noise', content: 'we deploy', usageCount: 9 }),
  entry('longform', { content: LONG_QUERY }),
];

/** Every entry that has "deploy" somewhere, in the LIKE rank: name, prefix, word, description, content. */
export const DEPLOY_BY_LIKE_RANK: readonly string[] = [
  'deploy',
  'deploy-hook',
  'auto deploy',
  'runner',
  'another',
  'other',
];

/** The corpus as the list path orders it: most used first, then by name. */
export const CORPUS_BY_USAGE: readonly string[] = [...CORPUS]
  .sort((a, b) => b.usageCount - a.usageCount || compareNames(a.name, b.name))
  .map(({ name }) => name);

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Queries the full-text path and the LIKE path must answer with the same set of entries, each
 * for a kind of input: punctuation inside a term, quotes, unicode, fts5 syntax typed by a user,
 * LIKE wildcards, ASCII case and length.
 */
export const PARITY_QUERIES: readonly string[] = [
  'security-scan',
  'security scan',
  '  security   scan  ',
  'PreToolUse:Bash:guard',
  'bmad-create-prd',
  '"scan',
  'scan"',
  '"',
  "it's",
  'café',
  '日本語',
  'scan OR browse',
  'browse OR review',
  'browse NOT review',
  'name:browse',
  'brow*',
  '^review',
  'NEAR(scan',
  'cache_warm',
  'pct%done',
  'back\\slash',
  'deploy',
  'DEPLOY',
  LONG_QUERY,
];

/** The parity queries that find nothing on purpose: fts5 syntax a user typed, read as words. */
export const PARITY_QUERIES_FINDING_NOTHING: readonly string[] = [
  'scan OR browse',
  'browse OR review',
  'browse NOT review',
  'name:browse',
  'NEAR(scan',
];

export interface PathDivergence {
  readonly query: string;
  /** The entries the full-text path finds. */
  readonly fts: readonly string[];
  /** The entries the LIKE path finds, on either backend. */
  readonly like: readonly string[];
  readonly because: string;
}

const SPANS_SEPARATORS =
  'on fts5 a term is tokens, so it spans the separators of a name; on LIKE it is one substring';
const TOKEN_PREFIX =
  'on fts5 a term is a prefix of a token; on LIKE it is a substring anywhere in a word';
const FOLDS_UNICODE =
  'fts5 (unicode61) folds diacritics and the case of every letter; LIKE folds ASCII case only';

/**
 * Queries the two paths answer differently, pinned so that the gap is known and does not widen
 * unnoticed. The paths share their terms (search-query.ts); what a term matches is each path's own.
 */
export const PATH_DIVERGENCES: readonly PathDivergence[] = [
  { query: 'coding-style', fts: ['coding style'], like: [], because: SPANS_SEPARATORS },
  { query: 'coding_style', fts: ['coding style'], like: [], because: SPANS_SEPARATORS },
  { query: 'scan-security', fts: ['scan security'], like: [], because: SPANS_SEPARATORS },
  { query: 'view', fts: [], like: ['review'], because: TOKEN_PREFIX },
  { query: 'eview', fts: [], like: ['review'], because: TOKEN_PREFIX },
  { query: 'tool use', fts: [], like: ['PreToolUse:Bash:guard'], because: TOKEN_PREFIX },
  {
    query: 'cache warm',
    fts: ['cache_warm'],
    like: ['cacheXwarm', 'cache_warm'],
    because: TOKEN_PREFIX,
  },
  { query: 'cafe', fts: ['café notes'], like: [], because: FOLDS_UNICODE },
  { query: 'CAFÉ', fts: ['café notes'], like: [], because: FOLDS_UNICODE },
];

export function names(results: readonly SearchResult[]): string[] {
  return results.map(({ entry: found }) => found.name);
}

export function sortedNames(results: readonly SearchResult[]): string[] {
  return names(results).sort();
}
