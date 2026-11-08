import { describe, it, expect } from 'vitest';
import {
  MAX_FRONTMATTER_JSON_BYTES,
  MAX_FRONTMATTER_STRING_CHARS,
  MAX_FRONTMATTER_TOTAL_CHARS,
  sanitizeFrontmatter,
} from '../parsers/sanitize-frontmatter.js';
import { parseFrontmatter } from '../parsers/utils.js';
import { cpuTimeMs } from './cpu-time.js';

/**
 * The node budget and the per-string cap bound the shape of the frontmatter copy, not its size: a
 * string of 48 000 characters that an alias repeats 1500 times is 1500 nodes of 48 000 characters
 * each, 72 MB of metadata from a 54 KB file. The copy therefore also carries a budget of characters,
 * spent on every visit of a string and on every key, and the serialised result has a hard cap in
 * bytes whatever the input.
 */

const KIB = 1024;
const SHARED_STRING_CHARS = 48_000;
const SHARED_COPIES = 1500;
const CPU_BUDGET_MS = 250;
const SOURCE_SLACK_CHARS = 4096;
const SOURCE_FACTOR = 4;

function serialisedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('sanitizeFrontmatter character budget', () => {
  it('bounds a long string that is shared by every element of a list', () => {
    const shared = 'a'.repeat(SHARED_STRING_CHARS);
    const data = { name: 'shared', triggers: Array<string>(SHARED_COPIES).fill(shared) };

    const { result, cpuMs } = cpuTimeMs(() => sanitizeFrontmatter(data));

    expect(serialisedBytes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_JSON_BYTES);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.data.name).toBe('shared');
    expect(cpuMs).toBeLessThan(CPU_BUDGET_MS);
  });

  it('bounds a long string that is shared by many keys', () => {
    const shared = 'a'.repeat(SHARED_STRING_CHARS);
    const keys = Array.from(
      { length: SHARED_COPIES },
      (_, index) => [`k${index}`, shared] as const,
    );
    const data = Object.fromEntries(keys);

    const result = sanitizeFrontmatter(data);

    expect(serialisedBytes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_JSON_BYTES);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it('keeps the first values and drops the ones past the budget, never a prefix of one', () => {
    const shared = 'a'.repeat(MAX_FRONTMATTER_STRING_CHARS);
    const copies = MAX_FRONTMATTER_TOTAL_CHARS / MAX_FRONTMATTER_STRING_CHARS;
    const data = { list: Array<string>(copies + 5).fill(shared) };

    const result = sanitizeFrontmatter(data);

    const kept = (result.data.list as string[]).length;
    expect(kept).toBeLessThanOrEqual(copies);
    expect(kept).toBeGreaterThan(0);
    expect(result.dropped).toBe(copies + 5 - kept);
    for (const item of result.data.list as string[]) expect(item).toBe(shared);
  });

  it('keeps the worst case below the byte cap: control characters escape to six bytes each', () => {
    const noisy = '\u0001'.repeat(MAX_FRONTMATTER_STRING_CHARS);
    const data = { list: Array<string>(40).fill(noisy) };

    const result = sanitizeFrontmatter(data);

    expect(serialisedBytes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_JSON_BYTES);
    expect(serialisedBytes(result.data)).toBeGreaterThan(MAX_FRONTMATTER_TOTAL_CHARS);
  });

  it('keeps the worst case below the byte cap: lone surrogates and three-byte characters', () => {
    const lone = '\ud800'.repeat(MAX_FRONTMATTER_STRING_CHARS);
    const wide = 'あ'.repeat(MAX_FRONTMATTER_STRING_CHARS);
    const data = { list: [lone, wide, lone, wide, lone, wide, lone, wide] };

    const result = sanitizeFrontmatter(data);

    expect(serialisedBytes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_JSON_BYTES);
  });

  it('drops a key that alone is over the string cap, with the value it names', () => {
    const data = { ['k'.repeat(MAX_FRONTMATTER_STRING_CHARS + 1)]: 'value', kept: 'yes' };

    const result = sanitizeFrontmatter(data);

    expect(Object.keys(result.data)).toEqual(['kept']);
    expect(result.dropped).toBe(1);
  });

  it('spends the budget on keys too: a mapping of long distinct keys is cut', () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 100; index += 1) {
      wide[`${String(index).padStart(3, '0')}${'k'.repeat(10 * KIB)}`] = index;
    }

    const result = sanitizeFrontmatter(wide);

    expect(serialisedBytes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_JSON_BYTES);
    expect(Object.keys(result.data).length).toBeLessThan(100);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it('leaves frontmatter of ordinary size untouched', () => {
    const data = {
      name: 'ordinary',
      description: 'd'.repeat(2 * KIB),
      tools: ['Bash', 'Read'],
      nested: { a: 'x'.repeat(KIB), b: [1, 2, 3] },
    };

    const result = sanitizeFrontmatter(data);

    expect(result.dropped).toBe(0);
    expect(result.data).toEqual(data);
  });
});

describe('sanitizeFrontmatter relative to its source', () => {
  it('never keeps more characters than a few times the source text it came from', () => {
    const shared = 'a'.repeat(2000);
    const data = { list: Array<string>(200).fill(shared) };
    const sourceChars = 3000;

    const result = sanitizeFrontmatter(data, sourceChars);

    const kept = (result.data.list as string[]).length * shared.length;
    expect(kept).toBeLessThanOrEqual(SOURCE_FACTOR * sourceChars + SOURCE_SLACK_CHARS);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it('keeps everything a source of that size can honestly hold', () => {
    const text = 'a'.repeat(5000);
    const data = { one: text, two: text };

    const result = sanitizeFrontmatter(data, 2 * text.length);

    expect(result.dropped).toBe(0);
    expect(result.data).toEqual(data);
  });
});

describe('sanitizeFrontmatter at the exact limit', () => {
  it('keeps what fills the budget to the character, and drops one more', () => {
    const sourceChars = 1000;
    const limit = SOURCE_FACTOR * sourceChars + SOURCE_SLACK_CHARS;
    const key = 'k';

    const fits = sanitizeFrontmatter({ [key]: 'x'.repeat(limit - key.length) }, sourceChars);
    const overflows = sanitizeFrontmatter(
      { [key]: 'x'.repeat(limit - key.length + 1) },
      sourceChars,
    );

    expect(fits.dropped).toBe(0);
    expect(Object.keys(fits.data)).toEqual([key]);
    expect(overflows.dropped).toBe(1);
    expect(Object.keys(overflows.data)).toEqual([]);
  });
});

describe('parseFrontmatter keeps its output bounded by its input', () => {
  it('keeps a long string and its single alias whole', () => {
    const text = 'a'.repeat(SHARED_STRING_CHARS);
    const raw = `---\nname: one\ns: &s "${text}"\ncopy: *s\n---\nbody\n`;

    const result = parseFrontmatter(raw);

    expect(result.recovery).toBeUndefined();
    expect(result.dropped).toBeUndefined();
    expect(result.data.s).toBe(text);
    expect(result.data.copy).toBe(text);
  });

  it('turns a long string repeated by many aliases into a skipped block, not 72 MB', () => {
    const text = 'a'.repeat(SHARED_STRING_CHARS);
    const aliases = Array<string>(SHARED_COPIES).fill('*s').join(', ');
    const raw = `---\nname: bomb\ns: &s "${text}"\ntriggers: [${aliases}]\n---\nbody\n`;

    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('line-based');
    expect(serialisedBytes(result.data)).toBeLessThan(KIB);
  });
});
