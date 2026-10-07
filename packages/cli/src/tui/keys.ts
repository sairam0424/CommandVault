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

/** True when Ink recognised the read as one key (an arrow, Enter, a Ctrl chord, ...). */
export function isResolvedKey(key: Key): boolean {
  return Object.values(key).some((flag) => flag === true);
}

/** Enter, Ctrl+O and Ctrl+F: the keys that act on the selected entry. */
export function isEntryActionKey(input: string, key: Key): boolean {
  return key.return || (key.ctrl && (input === 'o' || input === 'f'));
}

/** Typing never puts more bytes than this into one read; a paste routinely does. */
export const PASTE_MIN_LENGTH = 64;
// Two line breaks in one read: CRLF counts once, so a typed "x" + Enter stays a key.
const PASTE_MIN_LINE_BREAKS = 2;
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * A terminal without bracketed paste delivers a paste as one unresolved run of bytes. A run
 * with two or more line breaks, or longer than any typed read, is such a paste and must be
 * inserted as text: decoding its newlines as Enter would act on an entry once per line.
 */
export function isPasteLike(input: string, key: Key): boolean {
  if (isResolvedKey(key)) return false;
  if (input.length > PASTE_MIN_LENGTH) return true;
  const lineBreaks = input.match(LINE_BREAK)?.length ?? 0;
  return lineBreaks >= PASTE_MIN_LINE_BREAKS;
}

/**
 * The markers of a bracketed paste as Ink hands them to a key handler when they reach one at
 * all: ESC removed. Ink's input parser keeps a whole start marker for its paste channel, and holds
 * back a pending `\e[200`, but flushes a pending `\e`, `\e[`, `\e[2` or `\e[20` after 20 ms as a
 * key or as literal text (build/input-parser.js `hasPendingEscape`). A marker whose bytes arrive
 * further apart than that (a slow link, a scripted writer) therefore reaches the handler in two
 * reads: a piece, then the rest of the marker heading the body, which then arrives as plain keys.
 */
export const PASTE_START_TAIL = '[200~';
export const PASTE_END_TAIL = '[201~';
// A lone `[` is a key a person presses; from two characters on the piece is never typed text.
const PASTE_FRAGMENT_MIN_LENGTH = 2;

/**
 * A flushed piece of a paste start marker that no one types in one read (`[2`, `[20`): it is held
 * until the next read shows whether the rest of the marker follows it.
 */
export function isPasteStartFragment(input: string, key: Key): boolean {
  if (isResolvedKey(key) || input.length < PASTE_FRAGMENT_MIN_LENGTH) return false;
  return input.length < PASTE_START_TAIL.length && PASTE_START_TAIL.startsWith(input);
}

/** An unresolved event that is the end marker of a bracketed paste, ESC removed. */
export function isPasteEndTail(input: string, key: Key): boolean {
  return !isResolvedKey(key) && input === PASTE_END_TAIL;
}

const ESCAPE = '\x1b';
// Ink cuts a stdin read at every ESC and hands an escape sequence its key parser did not resolve
// over with the ESC removed. A CSI tail is `[`, parameter bytes, intermediate bytes and one final
// byte (ECMA-48 5.4); an OSC lead or a string terminator (ESC + one code point to Ink) is a bare
// `]` or `\`. SS3 (ESC O x) is left alone: Ink resolves every SS3 a terminal sends, and a two-letter
// word starting with O typed fast is a word.
const CONTROL_SEQUENCE_TAIL = /^\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]$/;
const OSC_LEAD_OR_TERMINATOR = /^[\]\\]$/;

/**
 * An unresolved event holding the tail of a CSI sequence: a key Ink does not know (a focus report,
 * a mouse event, a colour code pasted raw). Never text a person typed: no read holds it with text.
 */
export function isControlSequenceTail(input: string, key: Key): boolean {
  return !isResolvedKey(key) && CONTROL_SEQUENCE_TAIL.test(input);
}

// `input` may be an escape sequence less its ESC; a bare `]` or `\` is also a typed key, so what
// it is depends on the rest of its stdin read.
function isEscapeTail(input: string): boolean {
  return CONTROL_SEQUENCE_TAIL.test(input) || OSC_LEAD_OR_TERMINATOR.test(input);
}

/**
 * The bytes the terminal sent for an unresolved event, as pasted text: the ESC Ink stripped from
 * an escape sequence is put back, so the paste cleaner drops the sequence whole, an OSC payload up
 * to its BEL or terminator included, instead of typing the printable tail.
 */
export function rawBytes(input: string): string {
  return isEscapeTail(input) ? ESCAPE + input : input;
}

/**
 * A key as a person types it, as Ink hands it over: one key Ink resolved, or a short run of
 * printable text (fast typing, or tmux `send-keys` with a word). A run holding a control byte,
 * longer than any typed read, or shaped like the tail of an escape sequence is not, and what it
 * means depends on the rest of its stdin read.
 */
export function isTypedRun(input: string, key: Key): boolean {
  if (isResolvedKey(key)) return true;
  if (CONTROL_BYTE.test(input) || input.length > PASTE_MIN_LENGTH) return false;
  return !isEscapeTail(input);
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
