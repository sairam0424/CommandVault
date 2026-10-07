import { describe, it, expect } from 'vitest';
import { pasteText } from '../../tui/pasteText.js';

const LINES = 150;
const pastedLines = Array.from(
  { length: LINES },
  (_, i) => `def function_${i + 1}(arg): return arg * ${i + 1}  # some comment`,
);

describe('pasteText', () => {
  it('turns CRLF, LF and TAB into single spaces and trims the ends', () => {
    expect(pasteText('a\r\nb\nc\td\r')).toBe('a b c d');
    expect(pasteText('\n\n  spaced  out \t\n')).toBe('spaced out');
  });

  it('collapses a run of mixed whitespace and control bytes into one space', () => {
    expect(pasteText('a \r\n\t \x00\x1f b')).toBe('a b');
  });

  it('removes whole CSI sequences, not just their lead byte', () => {
    expect(pasteText('\x1b[31mred\x1b[0m text')).toBe('red text');
    expect(pasteText('\x1b[?2004hpaste\x1b[?2004l')).toBe('paste');
    expect(pasteText('\x1b[1;5Hcursor')).toBe('cursor');
  });

  it('removes OSC sequences ended by BEL or ST', () => {
    expect(pasteText('\x1b]0;window title\x07name')).toBe('name');
    expect(pasteText('\x1b]8;;https://x.test\x1b\\link')).toBe('link');
  });

  it('drops a lone ESC, DEL and the C1 range', () => {
    expect(pasteText('a\x1bb')).toBe('ab');
    expect(pasteText('a\x7fb')).toBe('a b');
    expect(pasteText('a\u0080b\u009fc')).toBe('a b c');
  });

  it('treats the Unicode line and paragraph separators as line breaks', () => {
    expect(pasteText('a\u2028b\u2029c')).toBe('a b c');
  });

  it('flattens an 8 KB multi-line paste into one line', () => {
    const raw = `${pastedLines.join('\n')}\n`;
    expect(raw.length).toBeGreaterThan(8000);

    const text = pasteText(raw);

    expect(text).not.toMatch(/[\r\n\t]/);
    expect(
      text.startsWith('def function_1(arg): return arg * 1 # some comment def function_2('),
    ).toBe(true);
    expect(text.endsWith(`# some comment`)).toBe(true);
  });

  it('keeps non-ASCII text, emoji included', () => {
    expect(pasteText('héllo ★ 🚀')).toBe('héllo ★ 🚀');
  });

  it('returns an empty string for a paste that holds nothing printable', () => {
    expect(pasteText('\r\n\t \x1b[2J')).toBe('');
    expect(pasteText('')).toBe('');
  });
});
