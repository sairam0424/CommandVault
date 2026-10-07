import { describe, expect, it } from 'vitest';
import {
  escapeLike,
  ftsMatchExpression,
  MAX_QUERY_TERMS,
  MAX_TERM_LENGTH,
  queryTerms,
  wordsOf,
  wordsOfSql,
} from '../indexer/search-query.js';

// The one place a query is read: the terms both sqlite search paths share, and what each path is
// handed for them. Parity between the paths starts here.

describe('queryTerms', () => {
  it('splits on whitespace and keeps the punctuation inside a term', () => {
    expect(queryTerms("security-scan  PreToolUse:Bash:guard\tit's")).toEqual([
      'security-scan',
      'PreToolUse:Bash:guard',
      "it's",
    ]);
  });

  it('trims a term to its letters and digits at both ends', () => {
    expect(queryTerms('scan* ^review "quoted" (paren) --flag "unbalanced')).toEqual([
      'scan',
      'review',
      'quoted',
      'paren',
      'flag',
      'unbalanced',
    ]);
  });

  it('drops a token with nothing to search for', () => {
    expect(queryTerms('')).toEqual([]);
    expect(queryTerms('   ')).toEqual([]);
    expect(queryTerms('" - * ^ ""')).toEqual([]);
    expect(queryTerms('" scan "')).toEqual(['scan']);
  });

  it('keeps unicode letters and digits', () => {
    expect(queryTerms('café 日本語 ½ x²')).toEqual(['café', '日本語', '½', 'x²']);
  });

  it('keeps the first spelling of a term that recurs in another ASCII case', () => {
    expect(queryTerms('Scan scan SCAN other')).toEqual(['Scan', 'other']);
  });

  it('keeps at most MAX_QUERY_TERMS terms, the first ones typed', () => {
    const words = Array.from({ length: MAX_QUERY_TERMS + 10 }, (_, index) => `w${index}`);
    expect(queryTerms(words.join(' '))).toEqual(words.slice(0, MAX_QUERY_TERMS));
  });

  it('cuts a term to its first MAX_TERM_LENGTH characters, counted as code points', () => {
    expect(queryTerms('a'.repeat(MAX_TERM_LENGTH + 10))).toEqual(['a'.repeat(MAX_TERM_LENGTH)]);
    expect(queryTerms('a'.repeat(MAX_TERM_LENGTH))).toEqual(['a'.repeat(MAX_TERM_LENGTH)]);
    // A letter outside the Basic Multilingual Plane (Deseret) is two UTF-16 units and one character.
    expect(queryTerms('\u{10400}'.repeat(MAX_TERM_LENGTH + 1))).toEqual([
      '\u{10400}'.repeat(MAX_TERM_LENGTH),
    ]);
  });

  it('trims a cut that ends on a separator, so a term still ends in a token character', () => {
    const term = `${'a'.repeat(MAX_TERM_LENGTH - 1)}-b`;
    expect(queryTerms(term)).toEqual(['a'.repeat(MAX_TERM_LENGTH - 1)]);
  });
});

describe('ftsMatchExpression', () => {
  it('quotes every term as a prefix phrase and requires all of them', () => {
    expect(ftsMatchExpression(['security-scan', 'owasp'])).toBe('"security-scan"* AND "owasp"*');
  });

  it('doubles a quote inside a term, the one character a phrase cannot hold as is', () => {
    expect(ftsMatchExpression(['secu"rity'])).toBe('"secu""rity"*');
  });

  it('leaves operators, column filters and wildcards inside the phrase, as words', () => {
    expect(ftsMatchExpression(['NOT', 'name:browse', 'NEAR(a', 'b*c'])).toBe(
      '"NOT"* AND "name:browse"* AND "NEAR(a"* AND "b*c"*',
    );
  });
});

describe('escapeLike', () => {
  it('escapes %, _ and the escape character, and nothing else', () => {
    expect(escapeLike('100%_sure\\yes')).toBe('100\\%\\_sure\\\\yes');
    expect(escapeLike("plain-text:it's/ok.md")).toBe("plain-text:it's/ok.md");
  });
});

describe('wordsOf and wordsOfSql', () => {
  it('turn every separator that joins words into a space, in JavaScript and in SQL alike', () => {
    expect(wordsOf('security-scan cache_warm a:b c.d e/f')).toBe(
      'security scan cache warm a b c d e f',
    );
    expect(wordsOfSql('e.name')).toBe(
      "replace(replace(replace(replace(replace(e.name, '-', ' '), '_', ' '), ':', ' '), '.', ' '), '/', ' ')",
    );
  });
});
