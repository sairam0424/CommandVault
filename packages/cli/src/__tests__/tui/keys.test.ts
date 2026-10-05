import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { decodeInput } from '../../tui/keys.js';

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
