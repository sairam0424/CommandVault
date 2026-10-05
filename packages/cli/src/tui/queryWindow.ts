import { cellWidth } from './text.js';

export interface QueryWindow {
  /** Characters left of the cursor that are shown. */
  readonly before: string;
  /** The character under the cursor; a space when the cursor is past the end. */
  readonly at: string;
  /** Characters right of the cursor that are shown. */
  readonly after: string;
}

const CURSOR_PAST_END = ' ';

/** First index from which `chars[start..end)` fits in `capacity` columns. */
function startFitting(chars: readonly string[], end: number, capacity: number): number {
  let start = end;
  let used = 0;
  while (start > 0 && used + cellWidth(chars[start - 1] ?? '') <= capacity) {
    start -= 1;
    used += cellWidth(chars[start] ?? '');
  }
  return start;
}

/** Last index (exclusive) up to which `chars[start..end)` fits in `capacity` columns. */
function endFitting(chars: readonly string[], start: number, capacity: number): number {
  let end = start;
  let used = 0;
  while (end < chars.length && used + cellWidth(chars[end] ?? '') <= capacity) {
    used += cellWidth(chars[end] ?? '');
    end += 1;
  }
  return end;
}

/**
 * The part of the query that fits on ONE row of `capacity` columns, cursor cell included. A query
 * that fits is shown whole; a longer one shows its tail, or the text from the cursor on when the
 * cursor sits left of that tail, so the cursor is always in view and the box never wraps.
 */
export function queryWindow(value: string, cursor: number, capacity: number): QueryWindow {
  const chars = Array.from(value);
  const cursorIndex = Array.from(value.slice(0, cursor)).length;
  const cursorChar = chars[cursorIndex] ?? CURSOR_PAST_END;
  const room = Math.max(1, capacity);

  // The tail, with a column kept for the cursor past its end; it holds the cursor unless the
  // cursor sits further left, where the window starts at the cursor instead.
  const tailStart = startFitting(chars, chars.length, room - cellWidth(CURSOR_PAST_END));
  const start = Math.min(tailStart, cursorIndex);
  const end = start === tailStart ? chars.length : endFitting(chars, start, room);

  return {
    before: chars.slice(start, cursorIndex).join(''),
    at: cursorChar,
    after: chars.slice(cursorIndex + 1, Math.max(end, cursorIndex + 1)).join(''),
  };
}
