import type { Key } from 'ink';

export interface EditState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY_EDIT: EditState = { value: '', cursor: 0 };

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

  if (!input) return state;
  return {
    value: value.slice(0, cursor) + input + value.slice(cursor),
    cursor: cursor + input.length,
  };
}
