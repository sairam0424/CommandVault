import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import {
  PASTE_END_TAIL,
  PASTE_MIN_LENGTH,
  PASTE_START_TAIL,
  decodeInput,
  isControlSequenceTail,
  isPasteEndTail,
  isPasteLike,
  isPasteStartFragment,
  isTypedRun,
  rawBytes,
} from '../../tui/keys.js';

const NO_KEY: Key = {
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

const summary = (input: string, key: Key = NO_KEY) =>
  decodeInput(input, key).map((e) => ({
    input: e.input,
    ctrl: e.key.ctrl,
    ret: e.key.return,
    tab: e.key.tab,
    back: e.key.backspace,
  }));

describe('decodeInput', () => {
  it('passes a plain printable run through as one event, untouched', () => {
    const events = decodeInput('abc', NO_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ input: 'abc', key: NO_KEY });
  });

  it('keeps the exact key object of a single key that Ink already resolved', () => {
    const ctrlC: Key = { ...NO_KEY, ctrl: true };
    const events = decodeInput('c', ctrlC);
    expect(events).toEqual([{ input: 'c', key: ctrlC }]);
    expect(events[0]?.key).toBe(ctrlC);
  });

  it('keeps the shift flag Ink sets for one upper-case letter', () => {
    const shifted: Key = { ...NO_KEY, shift: true };
    expect(decodeInput('A', shifted)[0]?.key).toBe(shifted);
  });

  it('keeps the bytes of a resolved key whose input holds a control byte', () => {
    // Ink reports a double Esc as one escape key whose input still carries the second ESC.
    const doubleEscape: Key = { ...NO_KEY, escape: true };
    const events = decodeInput('\x1b', doubleEscape);
    expect(events).toEqual([{ input: '\x1b', key: doubleEscape }]);
  });

  it('splits a Ctrl+C that trails typed text into text then a ctrl event', () => {
    expect(summary('ab\x03')).toEqual([
      { input: 'ab', ctrl: false, ret: false, tab: false, back: false },
      { input: 'c', ctrl: true, ret: false, tab: false, back: false },
    ]);
  });

  it('turns every control byte of a doubled Ctrl+C into its own event', () => {
    const events = summary('\x03\x03');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.input === 'c' && e.ctrl)).toBe(true);
  });

  it('maps Ctrl+F and Ctrl+O to the letters Ink would report', () => {
    expect(summary('\x06\x0f').map((e) => e.input)).toEqual(['f', 'o']);
  });

  it('keeps the order of text, control bytes and text', () => {
    expect(summary('a\x06b').map((e) => e.input)).toEqual(['a', 'f', 'b']);
  });

  it('reads CR and LF as Enter, HT as Tab and BS/DEL as backspace', () => {
    expect(summary('\r')).toHaveLength(1);
    const events = summary('x\r\n\t\x08\x7f');
    expect(events.map((e) => [e.ret, e.tab, e.back])).toEqual([
      [false, false, false],
      [true, false, false],
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [false, false, true],
    ]);
  });

  it('drops control bytes that mean nothing', () => {
    expect(summary('a\x00b\x1c\x1f').map((e) => e.input)).toEqual(['a', 'b']);
  });

  it('leaves non-ASCII text alone', () => {
    expect(decodeInput('héllo wörld ★', NO_KEY)).toEqual([{ input: 'héllo wörld ★', key: NO_KEY }]);
  });
});

// A terminal without bracketed paste delivers a paste as one run of raw bytes. Typing never
// produces two line breaks or more than 64 bytes in one read; a paste routinely does both.
describe('isPasteLike', () => {
  it('is false for typed text that ends in one Enter, CRLF counted once', () => {
    expect(isPasteLike('x\r\n', NO_KEY)).toBe(false);
    expect(isPasteLike('x\r', NO_KEY)).toBe(false);
    expect(isPasteLike('x\n', NO_KEY)).toBe(false);
  });

  it('is true for two line breaks in one read', () => {
    expect(isPasteLike('a\rb\r', NO_KEY)).toBe(true);
    expect(isPasteLike('a\nb\n', NO_KEY)).toBe(true);
    expect(isPasteLike('a\r\nb\r\n', NO_KEY)).toBe(true);
  });

  it('is true above the length limit and false at it', () => {
    expect(PASTE_MIN_LENGTH).toBe(64);
    expect(isPasteLike('a'.repeat(PASTE_MIN_LENGTH + 1), NO_KEY)).toBe(true);
    expect(isPasteLike('a'.repeat(PASTE_MIN_LENGTH), NO_KEY)).toBe(false);
  });

  it('is false for a key Ink already resolved, whatever its input holds', () => {
    const enter: Key = { ...NO_KEY, return: true };
    expect(isPasteLike('a\rb\r', enter)).toBe(false);
    const escape: Key = { ...NO_KEY, escape: true };
    expect(isPasteLike('a'.repeat(PASTE_MIN_LENGTH + 1), escape)).toBe(false);
  });
});

// Whether an event can be handled the moment it arrives, or must wait for the rest of its read.
describe('isTypedRun', () => {
  it('is true for one letter, a short word and any key Ink resolved', () => {
    expect(isTypedRun('a', NO_KEY)).toBe(true);
    expect(isTypedRun('demo', NO_KEY)).toBe(true);
    expect(isTypedRun('a'.repeat(PASTE_MIN_LENGTH), NO_KEY)).toBe(true);
    expect(isTypedRun('', { ...NO_KEY, return: true })).toBe(true);
    expect(isTypedRun('f', { ...NO_KEY, ctrl: true })).toBe(true);
  });

  it('is false for a run with a control byte in it, however short', () => {
    expect(isTypedRun('demo\n', NO_KEY)).toBe(false);
    expect(isTypedRun('x\r', NO_KEY)).toBe(false);
    expect(isTypedRun('ab\x03', NO_KEY)).toBe(false);
    expect(isTypedRun('\x06', NO_KEY)).toBe(false);
  });

  it('is false for a run longer than any typed read', () => {
    expect(isTypedRun('a'.repeat(PASTE_MIN_LENGTH + 1), NO_KEY)).toBe(false);
  });

  it('is false for the tail of an escape sequence, which only its read can explain', () => {
    expect(isTypedRun('[1m', NO_KEY)).toBe(false);
    expect(isTypedRun(']', NO_KEY)).toBe(false);
    expect(isTypedRun('\\', NO_KEY)).toBe(false);
  });
});

// Ink strips the ESC off an escape sequence its key parser did not resolve and hands over the rest.
describe('isControlSequenceTail', () => {
  it('is true for a CSI sequence less its ESC: parameters, intermediates, one final byte', () => {
    expect(isControlSequenceTail('[33m', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[1m', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[m', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[38;5;214m', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[01;31m', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[K', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[I', NO_KEY)).toBe(true);
    expect(isControlSequenceTail('[<0;10;20M', NO_KEY)).toBe(true);
  });

  it('is false for text, a bare bracket, an OSC lead, a word and a key Ink resolved', () => {
    expect(isControlSequenceTail('[', NO_KEY)).toBe(false);
    expect(isControlSequenceTail('[x]', NO_KEY)).toBe(false);
    expect(isControlSequenceTail(']', NO_KEY)).toBe(false);
    expect(isControlSequenceTail('OK', NO_KEY)).toBe(false);
    expect(isControlSequenceTail('demo\n', NO_KEY)).toBe(false);
    expect(isControlSequenceTail('[A', { ...NO_KEY, upArrow: true })).toBe(false);
  });
});

describe('rawBytes', () => {
  it('puts the ESC back on a CSI tail, an OSC lead and a string terminator', () => {
    expect(rawBytes('[33m')).toBe('\x1b[33m');
    expect(rawBytes('[K')).toBe('\x1b[K');
    expect(rawBytes(']')).toBe('\x1b]');
    expect(rawBytes('\\')).toBe('\x1b\\');
  });

  it('leaves text alone, a two-letter word starting with O included', () => {
    expect(rawBytes('demo\n')).toBe('demo\n');
    expect(rawBytes('OK')).toBe('OK');
    expect(rawBytes('[')).toBe('[');
    expect(rawBytes('')).toBe('');
  });
});

// Ink flushes a pending `\e[2` or `\e[20` as the text `[2` or `[20` after 20 ms; it holds `\e[200`
// and a whole marker back for its paste channel, so those never reach a key handler as text.
describe('isPasteStartFragment', () => {
  it('is true for a proper prefix of the start marker from two characters on', () => {
    expect(PASTE_START_TAIL).toBe('[200~');
    expect(isPasteStartFragment('[2', NO_KEY)).toBe(true);
    expect(isPasteStartFragment('[20', NO_KEY)).toBe(true);
    expect(isPasteStartFragment('[200', NO_KEY)).toBe(true);
  });

  it('is false for a lone bracket, which is a key a person presses', () => {
    expect(isPasteStartFragment('[', NO_KEY)).toBe(false);
  });

  it('is false for the whole marker, for text that merely starts like one, and for a resolved key', () => {
    expect(isPasteStartFragment('[200~', NO_KEY)).toBe(false);
    expect(isPasteStartFragment('[200~demo', NO_KEY)).toBe(false);
    expect(isPasteStartFragment('[2x', NO_KEY)).toBe(false);
    expect(isPasteStartFragment('20', NO_KEY)).toBe(false);
    expect(isPasteStartFragment('[20', { ...NO_KEY, meta: true })).toBe(false);
  });
});

describe('isPasteEndTail', () => {
  it('is true for the end marker less its ESC and nothing else', () => {
    expect(PASTE_END_TAIL).toBe('[201~');
    expect(isPasteEndTail('[201~', NO_KEY)).toBe(true);
    expect(isPasteEndTail('[200~', NO_KEY)).toBe(false);
    expect(isPasteEndTail('[201~x', NO_KEY)).toBe(false);
    expect(isPasteEndTail('[201~', { ...NO_KEY, ctrl: true })).toBe(false);
  });
});
