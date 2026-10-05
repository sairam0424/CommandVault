import { getContentExcerpt } from '@commandvault/core';
import { printable } from './text.js';

// The box border takes the top and bottom rows and a header line sits under the top one.
const PREVIEW_CHROME_ROWS = 3;

/** Text rows inside a preview pane that is `paneHeight` rows tall, border and header included. */
export function previewTextRows(paneHeight: number): number {
  return Math.max(1, paneHeight - PREVIEW_CHROME_ROWS);
}

export interface PreviewContent {
  /** Every line of the entry, ready to draw one per row. */
  readonly lines: readonly string[];
  /** The first line that holds a word of the query, or null. */
  readonly matchLine: number | null;
}

const WHOLE_CONTENT = Number.MAX_SAFE_INTEGER;

/** All the lines the pane can scroll through for this entry, with the first match marked. */
export function previewContent(content: string, query: string): PreviewContent {
  const { lines, matchLine } = getContentExcerpt(content, query, WHOLE_CONTENT);
  return { lines: lines.map(printable), matchLine };
}

/** The first line that holds a word of the query, or null. */
export function previewMatchLine(content: string, query: string): number | null {
  return getContentExcerpt(content, query, WHOLE_CONTENT).matchLine;
}

/**
 * Where the pane starts for an entry the user has not scrolled yet: the top, unless the first
 * match lies below the first page, in which case it sits in the middle of the pane.
 */
export function previewInitialTop(matchLine: number | null, textRows: number): number {
  if (matchLine === null || matchLine < textRows) return 0;
  return matchLine - Math.floor(textRows / 2);
}

/** How many lines the pane can scroll through: none when it falls back to metadata. */
export function previewLineCount(content: string): number {
  if (!content.trim()) return 0;
  return content.split('\n').length;
}
