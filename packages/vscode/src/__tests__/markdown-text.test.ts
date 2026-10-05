import { describe, expect, it } from 'vitest';
import { escapeMarkdownInline, fencedCodeBlock } from '../providers/markdown-text';
import { unescapedMarkup } from './helpers/hostile-text';

const MARKUP_CHARACTERS = [...'\\`*_{}[]()<>#+-.!|~&:=@'];

describe('escapeMarkdownInline', () => {
  it.each(MARKUP_CHARACTERS)('backslash-escapes %s', (character) => {
    expect(escapeMarkdownInline(`a${character}b`)).toBe(`a\\${character}b`);
  });

  it('leaves words, digits, commas and non-ASCII letters alone', () => {
    expect(escapeMarkdownInline('Review, plan 2 ünïcode 日本語')).toBe(
      'Review, plan 2 ünïcode 日本語',
    );
  });

  it('turns every run of whitespace and control characters into one space, and trims', () => {
    expect(escapeMarkdownInline('  a\n\n# b\r\n\tc\u0000d e f  ')).toBe('a \\# b c d e f');
  });

  it('cannot have its escapes undone by a backslash in the text', () => {
    const escaped = escapeMarkdownInline('\\[x\\](y)');

    expect(escaped).toBe('\\\\\\[x\\\\\\]\\(y\\)');
    expect(unescapedMarkup(escaped)).toEqual([]);
  });

  it('returns an empty string for text with nothing in it', () => {
    expect(escapeMarkdownInline(' \n\t ')).toBe('');
  });
});

describe('fencedCodeBlock', () => {
  it('uses a three-backtick fence for code with no backticks', () => {
    expect(fencedCodeBlock('ls -la')).toBe('```text\nls -la\n```\n');
  });

  it.each([
    [1, 3],
    [2, 3],
    [3, 4],
    [7, 8],
  ])('fences code containing a run of %i backticks with %i', (run, fenceLength) => {
    const code = `a ${'`'.repeat(run)} b`;

    const block = fencedCodeBlock(code);

    expect(block).toBe(`${'`'.repeat(fenceLength)}text\n${code}\n${'`'.repeat(fenceLength)}\n`);
  });

  it('measures the longest run, wherever it is', () => {
    expect(fencedCodeBlock('``\n`````\n`')).toMatch(/^`{6}text\n/);
  });
});
