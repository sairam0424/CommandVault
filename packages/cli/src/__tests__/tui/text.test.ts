import { describe, expect, it } from 'vitest';
import { printable, singleLine } from '../../tui/text.js';

const ESC = '\u001b';

describe('singleLine', () => {
  it('turns a run of C0 controls, a line break included, into one space', () => {
    expect(singleLine('a\r\n\tb')).toBe('a b');
    expect(singleLine('  lead\u0000trail  ')).toBe('lead trail');
  });

  it.each([
    ['8-bit OSC introducer', 'a\u009d0;Xb', 'a 0;Xb'],
    ['8-bit string terminator', 'a\u009cb', 'a b'],
    ['line separator', 'a\u2028b', 'a b'],
    ['right-to-left override', 'a\u202eb', 'a b'],
    ['left-to-right isolate', 'a\u2066b', 'a b'],
    ['7-bit ESC', `a${ESC}[2Jb`, 'a [2Jb'],
  ])('drops a %s like any other control', (_label, input, expected) => {
    expect(singleLine(input)).toBe(expected);
  });

  it('keeps emoji and wide text', () => {
    expect(singleLine('🧠 日本語 \u{1FA9D}')).toBe('🧠 日本語 \u{1FA9D}');
  });
});

describe('printable', () => {
  it('expands tabs and removes C0 controls', () => {
    expect(printable('a\tb\u0001c')).toBe('a    bc');
  });

  it.each([
    ['8-bit OSC introducer', 'a\u009d0;Xb', 'a0;Xb'],
    ['8-bit string terminator', 'a\u009cb', 'ab'],
    ['line separator', 'a\u2028b', 'ab'],
    ['right-to-left override', 'a\u202eb', 'ab'],
    ['7-bit ESC', `a${ESC}[31mb`, 'a[31mb'],
  ])('drops a %s', (_label, input, expected) => {
    expect(printable(input)).toBe(expected);
  });
});
