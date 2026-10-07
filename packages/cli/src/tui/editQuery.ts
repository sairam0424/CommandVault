import type { Key } from 'ink';

export interface EditState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY_EDIT: EditState = { value: '', cursor: 0 };

/**
 * Longest query the box takes. Every key that acts on an entry searches the query again, so a
 * paste of kilobytes would make each later key pay for a search over all of it; no name or
 * description is found by a longer query that a 200-character one misses.
 */
export const MAX_QUERY_LENGTH = 200;

const HIGH_SURROGATE_AT_END = /[\ud800-\udbff]$/;

/** The start of `input` that still fits a query of `length` characters, never half a pair. */
function fitting(input: string, length: number): string {
  const room = MAX_QUERY_LENGTH - length;
  if (room <= 0) return '';
  const kept = input.slice(0, room);
  return HIGH_SURROGATE_AT_END.test(kept) ? kept.slice(0, -1) : kept;
}

// Keys that belong to the surrounding screen (navigation, submit, dismiss),
// never to the text being edited.
function isScreenKey(key: Key): boolean {
  return (
    key.upArrow ||
    key.downArrow ||
    key.pageUp ||
    key.pageDown ||
    key.tab ||
    key.return ||
    key.escape
  );
}

export function clamp(position: number, length: number): number {
  return Math.max(0, Math.min(position, length));
}

/**
 * Pure edit step for the search box. Ctrl/Meta chords are ignored here on
 * purpose: ink reports Ctrl+F as input "f", so a generic text input would type
 * the letter and move the cursor every time an action shortcut is pressed.
 */
export function editQuery(state: EditState, input: string, key: Key): EditState {
  const { value, cursor } = state;
  if (key.ctrl || key.meta || isScreenKey(key)) return state;

  if (key.leftArrow) return { value, cursor: clamp(cursor - 1, value.length) };
  if (key.rightArrow) return { value, cursor: clamp(cursor + 1, value.length) };
  if (key.home) return { value, cursor: 0 };
  if (key.end) return { value, cursor: value.length };

  if (key.backspace || key.delete) {
    if (cursor === 0) return state;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }

  // Typed, batched and pasted text all arrive here: the one place the length cap applies.
  const inserted = fitting(input, value.length);
  if (!inserted) return state;
  return {
    value: value.slice(0, cursor) + inserted + value.slice(cursor),
    cursor: cursor + inserted.length,
  };
}
