/**
 * What the user typed, turned into the terms the two sqlite search paths share, and into the
 * expression each path needs: an fts5 MATCH expression or LIKE patterns. Both paths see the same
 * terms; what a term matches is each path's own (a prefix of a token for fts5, a substring for
 * LIKE; search-sql.ts), and search-parity.test.ts pins where the two agree and where they differ.
 */

/**
 * Terms past this many are ignored. Every term costs the LIKE path a few comparisons per row and
 * the full-text path a phrase; a query this long is a paste, not a search.
 */
export const MAX_QUERY_TERMS = 32;

/**
 * A term is cut to this many characters (code points). The LIKE path binds every term in one
 * pattern (search-sql.ts, `$exact` and `$prefix`), and SQLite refuses a pattern over 50000 bytes
 * (SQLITE_LIMIT_LIKE_PATTERN_LENGTH, "LIKE or GLOB pattern too complex"): MAX_QUERY_TERMS terms of
 * MAX_TERM_LENGTH characters of four bytes each, with the spaces between them, are 32800 bytes. A
 * term that long is a paste, not a search; its first characters are what is searched for.
 */
export const MAX_TERM_LENGTH = 256;

/** The LIKE escape character every pattern here uses; the SQL spells it `ESCAPE '\'`. */
export const LIKE_ESCAPE = '\\';
const LIKE_SPECIALS = /[\\%_]/g;

/**
 * A character the fts5 `unicode61` tokenizer keeps (a letter, a digit, a private-use character);
 * everything else separates tokens. A term is trimmed to its outermost token characters, so
 * `scan*`, `^scan` and `"scan` are the term `scan` on both paths, and a token with no such
 * character (`-`, `"`, `*`) is nothing to search for. Characters inside a term stay: `security-scan`
 * is one term, a phrase for fts5 and a substring for LIKE.
 */
const TOKEN_CHARACTER = '\\p{L}\\p{N}\\p{Co}';
const EDGE_SEPARATORS = new RegExp(`^[^${TOKEN_CHARACTER}]+|[^${TOKEN_CHARACTER}]+$`, 'gu');

/**
 * Characters that join the words of a name: `security-scan`, `cache_warm`, `PreToolUse:Bash:guard`,
 * `cmd/sub`, `file.md`. `wordsOf` and `wordsOfSql` turn each into a space, so the LIKE rank sees
 * the same words in a name and in a query however they were joined.
 */
const WORD_SEPARATORS = ['-', '_', ':', '.', '/'] as const;

/**
 * `term` cut to MAX_TERM_LENGTH characters. A cut can end on a separator inside the term; it is
 * trimmed again, so a term still ends in a token character. Never empty: the first character is one.
 */
function clipTerm(term: string): string {
  const characters = [...term];
  if (characters.length <= MAX_TERM_LENGTH) return term;
  return characters.slice(0, MAX_TERM_LENGTH).join('').replace(EDGE_SEPARATORS, '');
}

/**
 * The distinct terms of `query`, in the order typed, at most MAX_QUERY_TERMS of them, each at most
 * MAX_TERM_LENGTH characters. Two terms that differ only in ASCII case are one: neither path tells
 * them apart.
 */
export function queryTerms(query: string): string[] {
  const terms = new Map<string, string>();
  for (const token of query.split(/\s+/)) {
    const term = clipTerm(token.replace(EDGE_SEPARATORS, ''));
    if (term.length === 0) continue;
    const key = term.toLowerCase();
    if (!terms.has(key)) terms.set(key, term);
    if (terms.size === MAX_QUERY_TERMS) break;
  }
  return [...terms.values()];
}

/**
 * One quoted phrase per term, the last token of each a prefix, every phrase required. Inside a
 * phrase fts5 reads nothing as syntax (a doubled quote stands for one), so `AND`, `OR`, `NOT`,
 * `NEAR`, `*`, `^` and `column:` typed by a user are words to find, not operators.
 */
export function ftsMatchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
}

/** `text` with `%`, `_` and the escape character itself escaped, so that each means itself. */
export function escapeLike(text: string): string {
  return text.replace(LIKE_SPECIALS, (special) => `${LIKE_ESCAPE}${special}`);
}

/** The words of `text`, separators turned into spaces; the JavaScript side of `wordsOfSql`. */
export function wordsOf(text: string): string {
  return WORD_SEPARATORS.reduce((words, separator) => words.replaceAll(separator, ' '), text);
}

/** The SQL for `wordsOf(<column>)`: one replace() per separator, applied in the same order. */
export function wordsOfSql(column: string): string {
  return WORD_SEPARATORS.reduce(
    (expression, separator) => `replace(${expression}, '${separator}', ' ')`,
    column,
  );
}
