import { getContentExcerpt } from '@commandvault/core';
import type { ContentExcerpt } from '@commandvault/core';

// The preview pane is a bordered box, so its text starts one row down and ends one row early.
const PREVIEW_BORDER_ROWS = 2;
// The pane keeps this many screens of content around the first match.
const EXCERPT_SCREENS = 2;

/** Text rows inside a preview pane that is `paneHeight` rows tall, border included. */
export function previewTextRows(paneHeight: number): number {
  return Math.max(1, paneHeight - PREVIEW_BORDER_ROWS);
}

/** The lines the pane can scroll through for this entry, as it draws them. */
export function previewExcerpt(content: string, query: string, paneHeight: number): ContentExcerpt {
  return getContentExcerpt(content, query, paneHeight * EXCERPT_SCREENS);
}

/** How many lines the pane can scroll through: none when it falls back to metadata. */
export function previewLineCount(content: string, query: string, paneHeight: number): number {
  if (!content.trim()) return 0;
  return previewExcerpt(content, query, paneHeight).lines.length;
}
