import type { Key } from 'ink';

/** One key press, in the shape `useInput` hands to a handler. */
export interface KeyEvent {
  readonly input: string;
  readonly key: Key;
}

export const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

const BACKSPACE_BYTE = 0x08;
const TAB_BYTE = 0x09;
const LINE_FEED_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;
const DELETE_BYTE = 0x7f;
const FIRST_CTRL_LETTER_BYTE = 0x01;
const LAST_CTRL_LETTER_BYTE = 0x1a;
// Ctrl+A is byte 0x01 and the letter "a" is 0x61.
const CTRL_LETTER_OFFSET = 0x60;

const CONTROL_BYTE = /([\u0000-\u001f\u007f])/;

const NAMED_CONTROL_KEYS: Readonly<Record<number, Partial<Key>>> = {
  [BACKSPACE_BYTE]: { backspace: true },
  [DELETE_BYTE]: { backspace: true },
  [TAB_BYTE]: { tab: true },
  [LINE_FEED_BYTE]: { return: true },
  [CARRIAGE_RETURN_BYTE]: { return: true },
};

function controlEvent(code: number): readonly KeyEvent[] {
  const named = NAMED_CONTROL_KEYS[code];
  if (named) return [{ input: '', key: { ...NO_KEY, ...named } }];
  if (code >= FIRST_CTRL_LETTER_BYTE && code <= LAST_CTRL_LETTER_BYTE) {
    const letter = String.fromCharCode(code + CTRL_LETTER_OFFSET);
    return [{ input: letter, key: { ...NO_KEY, ctrl: true } }];
  }
  // NUL and the remaining separators mean nothing here; typing them into the
  // search box would only corrupt the query.
  return [];
}

function isResolvedKey(key: Key): boolean {
  return Object.values(key).some((flag) => flag === true);
}

/**
 * Ink hands `useInput` one event per escape sequence, but every plain run of
 * bytes between two sequences arrives as a single event, control bytes
 * included. Fast typing, a paste and tmux `send-keys` all produce such runs,
 * so a Ctrl+C, Ctrl+F or Enter sitting inside one would be typed as text.
 * This splits a run into printable text and single control keys, in order.
 *
 * Limit: Esc followed by another byte in the same read is one Alt chord to Ink
 * (a terminal sends Alt+z as ESC "z"), and the box ignores Alt chords. Esc is
 * therefore only honoured when it ends the read.
 */
export function decodeInput(input: string, key: Key): readonly KeyEvent[] {
  if (isResolvedKey(key) || !CONTROL_BYTE.test(input)) return [{ input, key }];
  return input
    .split(CONTROL_BYTE)
    .filter((part) => part !== '')
    .flatMap((part) =>
      CONTROL_BYTE.test(part) ? controlEvent(part.charCodeAt(0)) : [{ input: part, key: NO_KEY }],
    );
}
