export interface ContentExcerpt {
  lines: string[];
  matchLine: number | null;
}

/**
 * Returns a windowed slice of `content` lines centred around the first line
 * that contains any token from `query` (case-insensitive).
 *
 * @param content  - Raw multi-line string to slice
 * @param query    - Space-separated search tokens; any token match wins
 * @param maxLines - Maximum number of lines to return (default: 12)
 * @returns        - { lines: string[]; matchLine: number | null }
 *                   `matchLine` is the index within the returned `lines` array,
 *                   or null if no match was found.
 */
export function getContentExcerpt(
  content: string,
  query: string,
  maxLines = 12,
): ContentExcerpt {
  if (!content) {
    return { lines: [], matchLine: null };
  }

  const allLines = content.split('\n');

  // Tokenise the query — filter out empty strings from multiple spaces
  const tokens = query
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);

  // Find the first line (0-indexed) that contains any query token
  let matchIndex: number | null = null;
  if (tokens.length > 0) {
    for (let i = 0; i < allLines.length; i++) {
      const lower = allLines[i].toLowerCase();
      if (tokens.some((token) => lower.includes(token))) {
        matchIndex = i;
        break;
      }
    }
  }

  // If content is short enough, return it all
  if (allLines.length <= maxLines) {
    return {
      lines: allLines,
      matchLine: matchIndex,
    };
  }

  // No match — return first maxLines lines
  if (matchIndex === null) {
    return {
      lines: allLines.slice(0, maxLines),
      matchLine: null,
    };
  }

  // Centre the window around the matched line
  const half = Math.floor(maxLines / 2);
  let start = matchIndex - half;
  let end = start + maxLines;

  // Clamp to valid range
  if (start < 0) {
    start = 0;
    end = maxLines;
  } else if (end > allLines.length) {
    end = allLines.length;
    start = end - maxLines;
  }

  const lines = allLines.slice(start, end);
  const matchLine = matchIndex - start;

  return { lines, matchLine };
}
