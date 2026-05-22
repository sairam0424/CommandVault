/**
 * fzf-style query parser for CommandVault search.
 *
 * Operators:
 *   'term   — exact match (case-insensitive substring)
 *   ^term   — prefix match (name/description starts with)
 *   !term   — exclude (entries containing this term are removed)
 *   tag:v   — inline tag filter
 *   type:v  — inline type filter
 *   source:v — inline source filter
 *
 * Everything else is treated as a regular fuzzy search term.
 */

export interface ParsedQuery {
  readonly terms: string[];
  readonly exactTerms: string[];
  readonly prefixTerms: string[];
  readonly excludeTerms: string[];
  readonly filters: {
    readonly tags?: string[];
    readonly type?: string;
    readonly source?: string;
  };
}

const FILTER_PATTERN = /^(tag|type|source):(.+)$/;

export function parseQuery(rawQuery: string): ParsedQuery {
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);

  const terms: string[] = [];
  const exactTerms: string[] = [];
  const prefixTerms: string[] = [];
  const excludeTerms: string[] = [];
  const tags: string[] = [];
  let type: string | undefined;
  let source: string | undefined;

  for (const token of tokens) {
    if (token.startsWith("'") && token.length > 1) {
      exactTerms.push(token.slice(1));
    } else if (token.startsWith('^') && token.length > 1) {
      prefixTerms.push(token.slice(1));
    } else if (token.startsWith('!') && token.length > 1) {
      excludeTerms.push(token.slice(1));
    } else {
      const filterMatch = FILTER_PATTERN.exec(token);
      if (filterMatch) {
        const [, key, value] = filterMatch;
        if (key === 'tag') tags.push(value);
        else if (key === 'type') type = value;
        else if (key === 'source') source = value;
      } else {
        terms.push(token);
      }
    }
  }

  return {
    terms,
    exactTerms,
    prefixTerms,
    excludeTerms,
    filters: {
      ...(tags.length > 0 ? { tags } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(source !== undefined ? { source } : {}),
    },
  };
}

/**
 * Post-filter entries based on parsed exact, prefix, and exclude terms.
 * Works on the combined searchable text (name + description + content).
 */
export function applyQueryFilters<T extends { name: string; description: string; content: string }>(
  entries: readonly T[],
  parsed: ParsedQuery,
): T[] {
  if (
    parsed.exactTerms.length === 0 &&
    parsed.prefixTerms.length === 0 &&
    parsed.excludeTerms.length === 0
  ) {
    return [...entries];
  }

  return entries.filter((entry) => {
    const searchText = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    const descLower = entry.description.toLowerCase();

    for (const exact of parsed.exactTerms) {
      if (!searchText.includes(exact.toLowerCase())) return false;
    }

    for (const prefix of parsed.prefixTerms) {
      const prefixLower = prefix.toLowerCase();
      if (!nameLower.startsWith(prefixLower) && !descLower.startsWith(prefixLower)) return false;
    }

    for (const exclude of parsed.excludeTerms) {
      if (searchText.includes(exclude.toLowerCase())) return false;
    }

    return true;
  });
}
