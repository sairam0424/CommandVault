import { describe, expect, it } from 'vitest';
import { safeText, toDisplay } from '../../ui/safe-text.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

/** [label, hostile input, what must come out]. */
const HOSTILE_ROWS: readonly (readonly [string, string, string])[] = [
  ['OSC 0 title with BEL', `name${ESC}]0;PWNED-TITLE${BEL}tail`, 'nametail'],
  ['OSC 8 hyperlink with ST', `${ESC}]8;;https://evil/${ST}LINK${ESC}]8;;${ST}`, 'LINK'],
  ['OSC 52 clipboard', `a${ESC}]52;c;UFdORUQ=${BEL}b`, 'ab'],
  ['unterminated OSC eats to the end', `name${ESC}]0;PWNED`, 'name'],
  ['CSI clear screen', `a${ESC}[2Jb`, 'ab'],
  ['SGR red', `${ESC}[31mRED${ESC}[0m`, 'RED'],
  ['ESC ( B charset', `a${ESC}(Bb`, 'ab'],
  ['ESC c reset', `a${ESC}cb`, 'ab'],
  ['8-bit CSI', 'a\u009b2Jb', 'ab'],
  ['8-bit OSC with 8-bit ST', 'a\u009d0;X\u009cb', 'ab'],
  ['8-bit DCS', 'a\u0090dcs\u009cb', 'ab'],
  ['8-bit PM, unterminated', 'a\u009epm', 'a'],
  ['8-bit APC, unterminated', 'a\u009fapc', 'a'],
  ['lone ESC at the end', `a${ESC}`, 'a'],
  ['lone 8-bit ST', 'a\u009cb', 'ab'],
  ['DEL', 'a\u007fb', 'ab'],
  ['CR LF becomes one space', 'a\r\nb', 'a b'],
  ['a run of line breaks becomes one space', 'a\n\n\r\nb', 'a b'],
  ['a trailing line break becomes a trailing space', 'a\n', 'a '],
  ['line separator', 'a\u2028b', 'ab'],
  ['paragraph separator', 'a\u2029b', 'ab'],
  ['right-to-left override', 'a\u202eb', 'ab'],
  ['left-to-right isolate', 'a\u2066b', 'ab'],
  ['pop directional isolate', 'a\u2069b', 'ab'],
  ['ESC inside an OSC body aborts it, then acts on its own', `${ESC}]0;X${ESC}[2Jrest`, '0;Xrest'],
  ['7-bit ST on its own', `a${ST}b`, 'ab'],
];

const KEPT_ROWS: readonly (readonly [string, string])[] = [
  ['tab', 'a\tb'],
  ['CJK', '日本語'],
  ['emoji', '🧠'],
  ['ZWJ family', '👨‍👩‍👧'],
  ['combining acute', 'é'],
  ['NBSP', 'a\u00a0b'],
  ['[2J as plain text', '[2J'],
  ['hook emoji whose UTF-8 holds byte 0x9D', '\u{1FA9D}'],
];

describe('safeText', () => {
  it.each(HOSTILE_ROWS)('%s', (_label, input, expected) => {
    expect(safeText(input)).toBe(expected);
  });

  it.each(KEPT_ROWS)('keeps %s unchanged', (_label, input) => {
    expect(safeText(input)).toBe(input);
  });

  it.each([...HOSTILE_ROWS.map((row) => row[1]), ...KEPT_ROWS.map((row) => row[1])])(
    'is idempotent on %j',
    (input) => {
      const once = safeText(input);
      expect(safeText(once)).toBe(once);
    },
  );

  it('leaves no control code point at all in a combined payload', () => {
    const payload = `hostile${ESC}]0;T${BEL}${ESC}[2J\u009d0;C1\u009c\u202eBIDI\u0090dcs${ESC}P x`;
    const out = safeText(payload);
    const bad = [...out].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x202e;
    });
    expect(bad).toEqual([]);
    expect(out).toContain('hostile');
  });
});

describe('toDisplay', () => {
  const entry = {
    name: `n${ESC}]0;X${BEL}`,
    usageCount: 3,
    favorite: true,
    lastModified: new Date('2026-01-01T00:00:00Z'),
    tags: [`t${ESC}[2J`, 'ok'],
    metadata: { [`k${ESC}[31m`]: `v\u009d0;X\u009c`, nested: { deep: [`d${ESC}c`] }, n: 1 },
  };

  it('cleans strings, tags and nested metadata keys and values', () => {
    const view = toDisplay(entry);
    expect(view.name).toBe('n');
    expect(view.tags).toEqual(['t', 'ok']);
    expect(view.metadata).toEqual({ k: 'v', nested: { deep: ['d'] }, n: 1 });
  });

  it('returns new objects and leaves the input alone', () => {
    const view = toDisplay(entry);
    expect(view).not.toBe(entry);
    expect(view.tags).not.toBe(entry.tags);
    expect(view.metadata).not.toBe(entry.metadata);
    expect(entry.name).toContain(ESC);
    expect(entry.tags[0]).toContain(ESC);
  });

  it('keeps numbers, booleans and Dates as they are', () => {
    const view = toDisplay(entry);
    expect(view.usageCount).toBe(3);
    expect(view.favorite).toBe(true);
    expect(view.lastModified).toBe(entry.lastModified);
    expect(view.lastModified).toBeInstanceOf(Date);
  });

  it('cleans a bare array', () => {
    expect([...toDisplay([`a${ESC}[2J`, 'b'])]).toEqual(['a', 'b']);
  });

  it('replaces nesting past the depth cap with an empty container instead of copying it raw', () => {
    type Deep = { readonly v?: string; readonly next?: Deep };
    const leaf: Deep = { v: `leaf${ESC}[2J` };
    const deep = Array.from({ length: 12 }, () => 0).reduce<Deep>((next) => ({ next }), leaf);
    const view = toDisplay(deep);
    expect(JSON.stringify(view)).not.toContain(ESC);
    expect(JSON.stringify(view)).not.toContain('leaf');
  });
});
