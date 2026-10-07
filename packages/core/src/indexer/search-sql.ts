import type { SearchOptions } from '../types/index.js';
import {
  escapeLike,
  ftsMatchExpression,
  LIKE_ESCAPE,
  wordsOf,
  wordsOfSql,
} from './search-query.js';

/**
 * The SQL of the sqlite search tier: the list a query with no term gets, the full-text search a
 * build with fts5 runs, and the LIKE search that stands in for it. All three select `e.*` from
 * `entries e`, apply the same filters and page the same way; the engine decides which one runs.
 */

export interface SqlStatement {
  readonly sql: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Clauses {
  readonly conditions: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
}

const DEFAULT_LIMIT = 50;
const ESCAPE = `ESCAPE '${LIKE_ESCAPE}'`;
/** The columns both text paths search; the full-text table indexes the same four. */
const SEARCHED_COLUMNS = ['name', 'description', 'tags', 'content'] as const;
const NAME_WORDS = wordsOfSql('e.name');

/**
 * Where a LIKE match stands, lowest first; equal ranks are ordered by usage, then name. The query
 * is its terms joined by one space, compared word for word with the name (`security scan` is the
 * name `security-scan`); ASCII case never counts.
 */
const LIKE_RANK = {
  /** The name is the query. */
  exactName: 0,
  /** The name starts with the query. */
  namePrefix: 1,
  /** Every term starts a word of the name. */
  nameWords: 2,
  /** Every term is somewhere in the name or the description. */
  nameOrDescription: 3,
  /** Every term is somewhere in the entry, some only in the tags or the content. */
  elsewhere: 4,
} as const;

/** The filters on `entries e` every path applies; a tag is matched in the scan's tags or the user's. */
function filterClauses(options: SearchOptions): Clauses {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (options.type) {
    conditions.push('e.type = $type');
    params.$type = options.type;
  }
  if (options.source) {
    conditions.push('e.source = $source');
    params.$source = options.source;
  }
  if (options.favoritesOnly) conditions.push('e.favorite = 1');
  (options.tags ?? []).forEach((tag, index) => {
    const param = `$tag${index}`;
    conditions.push(
      `(EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = e.id AND tag = ${param})
        OR EXISTS (SELECT 1 FROM user_tags WHERE entry_id = e.id AND tag = ${param}))`,
    );
    params[param] = tag;
  });
  if (options.modifiedAfter) {
    conditions.push('e.last_modified >= $modifiedAfter');
    params.$modifiedAfter = options.modifiedAfter.toISOString();
  }
  if (options.modifiedBefore) {
    conditions.push('e.last_modified <= $modifiedBefore');
    params.$modifiedBefore = options.modifiedBefore.toISOString();
  }
  return { conditions, params };
}

function pagingParams(options: SearchOptions): Record<string, number> {
  return { $limit: options.limit ?? DEFAULT_LIMIT, $offset: options.offset ?? 0 };
}

function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

/** Every entry the filters keep, most used first; no text is looked at. */
export function listSql(options: SearchOptions): SqlStatement {
  const filters = filterClauses(options);
  return {
    sql: `SELECT e.* FROM entries e ${whereClause(filters.conditions)}
          ORDER BY e.usage_count DESC, e.name ASC LIMIT $limit OFFSET $offset`,
    params: { ...filters.params, ...pagingParams(options) },
  };
}

/**
 * Full-text search over the table fts5 maintains, which ranks the matches; fails without the
 * module or the table. `terms` must not be empty.
 */
export function ftsSearchSql(options: SearchOptions, terms: readonly string[]): SqlStatement {
  const filters = filterClauses(options);
  return {
    sql: `SELECT e.* FROM entries e JOIN entries_fts f ON e.id = f.id
          ${whereClause(['entries_fts MATCH $ftsQuery', ...filters.conditions])}
          ORDER BY f.rank, e.usage_count DESC, e.name ASC LIMIT $limit OFFSET $offset`,
    params: {
      ...filters.params,
      ...pagingParams(options),
      $ftsQuery: ftsMatchExpression(terms),
    },
  };
}

/** Every term somewhere in the entry: `$q<i>` is `%term%`, escaped. */
function likeMatchConditions(terms: readonly string[]): string[] {
  return terms.map(
    (_, index) =>
      `(${SEARCHED_COLUMNS.map((column) => `e.${column} LIKE $q${index} ${ESCAPE}`).join(' OR ')})`,
  );
}

/** The CASE that computes LIKE_RANK for a row; `$w<i>` is `% term%` over the words of the name. */
function likeRankSql(terms: readonly string[]): string {
  const everyTerm = (condition: (index: number) => string): string =>
    terms.map((_, index) => condition(index)).join(' AND ');
  return `CASE
    WHEN ${NAME_WORDS} LIKE $exact ${ESCAPE} THEN ${LIKE_RANK.exactName}
    WHEN ${NAME_WORDS} LIKE $prefix ${ESCAPE} THEN ${LIKE_RANK.namePrefix}
    WHEN ${everyTerm((i) => `(' ' || ${NAME_WORDS}) LIKE $w${i} ${ESCAPE}`)} THEN ${LIKE_RANK.nameWords}
    WHEN ${everyTerm((i) => `(e.name || ' ' || e.description) LIKE $q${i} ${ESCAPE}`)} THEN ${LIKE_RANK.nameOrDescription}
    ELSE ${LIKE_RANK.elsewhere} END`;
}

function likeParams(terms: readonly string[]): Record<string, string> {
  const phrase = escapeLike(wordsOf(terms.join(' ')));
  return {
    ...Object.fromEntries(terms.map((term, index) => [`$q${index}`, `%${escapeLike(term)}%`])),
    ...Object.fromEntries(
      terms.map((term, index) => [`$w${index}`, `% ${escapeLike(wordsOf(term))}%`]),
    ),
    $exact: phrase,
    $prefix: `${phrase}%`,
  };
}

/**
 * The search a build without fts5 runs, or one whose table is gone: every term must be somewhere
 * in the name, description, tags or content (a substring, ASCII case ignored, `%`, `_` and `\`
 * meaning themselves), ranked by LIKE_RANK, then usage, then name. `terms` must not be empty.
 */
export function likeSearchSql(options: SearchOptions, terms: readonly string[]): SqlStatement {
  const filters = filterClauses(options);
  return {
    sql: `SELECT e.* FROM entries e
          ${whereClause([...likeMatchConditions(terms), ...filters.conditions])}
          ORDER BY ${likeRankSql(terms)}, e.usage_count DESC, e.name ASC LIMIT $limit OFFSET $offset`,
    params: { ...filters.params, ...pagingParams(options), ...likeParams(terms) },
  };
}
