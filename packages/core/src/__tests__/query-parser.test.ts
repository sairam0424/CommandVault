import { describe, it, expect } from 'vitest';
import { parseQuery, applyQueryFilters, type ParsedQuery } from '../indexer/query-parser.js';

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------

describe('parseQuery', () => {
  it('treats plain query with no operators as regular terms', () => {
    const result = parseQuery('deploy server');
    expect(result.terms).toEqual(['deploy', 'server']);
    expect(result.exactTerms).toEqual([]);
    expect(result.prefixTerms).toEqual([]);
    expect(result.excludeTerms).toEqual([]);
    expect(result.filters).toEqual({});
  });

  it('parses exact match operator', () => {
    const result = parseQuery("'deploy");
    expect(result.exactTerms).toEqual(['deploy']);
    expect(result.terms).toEqual([]);
  });

  it('parses prefix match operator', () => {
    const result = parseQuery('^pre');
    expect(result.prefixTerms).toEqual(['pre']);
    expect(result.terms).toEqual([]);
  });

  it('parses exclude operator', () => {
    const result = parseQuery('!exclude');
    expect(result.excludeTerms).toEqual(['exclude']);
    expect(result.terms).toEqual([]);
  });

  it('parses tag filter', () => {
    const result = parseQuery('tag:security');
    expect(result.filters.tags).toEqual(['security']);
    expect(result.terms).toEqual([]);
  });

  it('parses type filter', () => {
    const result = parseQuery('type:skill');
    expect(result.filters.type).toBe('skill');
    expect(result.terms).toEqual([]);
  });

  it('parses source filter', () => {
    const result = parseQuery('source:gstack');
    expect(result.filters.source).toBe('gstack');
    expect(result.terms).toEqual([]);
  });

  it('parses mixed query with all operators', () => {
    const result = parseQuery("deploy 'exact !bad type:skill");
    expect(result.terms).toEqual(['deploy']);
    expect(result.exactTerms).toEqual(['exact']);
    expect(result.excludeTerms).toEqual(['bad']);
    expect(result.filters.type).toBe('skill');
  });

  it('returns empty arrays for empty query', () => {
    const result = parseQuery('');
    expect(result.terms).toEqual([]);
    expect(result.exactTerms).toEqual([]);
    expect(result.prefixTerms).toEqual([]);
    expect(result.excludeTerms).toEqual([]);
    expect(result.filters).toEqual({});
  });

  it('returns empty arrays for whitespace-only query', () => {
    const result = parseQuery('   ');
    expect(result.terms).toEqual([]);
    expect(result.exactTerms).toEqual([]);
    expect(result.prefixTerms).toEqual([]);
    expect(result.excludeTerms).toEqual([]);
    expect(result.filters).toEqual({});
  });

  it('collects multiple tags', () => {
    const result = parseQuery('tag:security tag:auth');
    expect(result.filters.tags).toEqual(['security', 'auth']);
  });

  it('ignores bare operator prefix with no value', () => {
    const result = parseQuery("' ^ !");
    // Single-char tokens (just the operator) should be treated as regular terms
    expect(result.terms).toEqual(["'", '^', '!']);
    expect(result.exactTerms).toEqual([]);
    expect(result.prefixTerms).toEqual([]);
    expect(result.excludeTerms).toEqual([]);
  });

  it('handles colon in value without matching a known filter key', () => {
    const result = parseQuery('foo:bar');
    expect(result.terms).toEqual(['foo:bar']);
    expect(result.filters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// applyQueryFilters
// ---------------------------------------------------------------------------

describe('applyQueryFilters', () => {
  const entries = [
    { name: 'deploy-server', description: 'Deploy to production', content: 'handles deploys' },
    { name: 'browse', description: 'Headless browser QA', content: 'navigate URLs' },
    { name: 'security-scan', description: 'Run OWASP checks', content: 'check vulnerabilities' },
    { name: 'prefix-match', description: 'Starts with prefix', content: 'testing prefix' },
  ];

  it('returns all entries when no query filters are active', () => {
    const parsed: ParsedQuery = {
      terms: ['foo'],
      exactTerms: [],
      prefixTerms: [],
      excludeTerms: [],
      filters: {},
    };
    const result = applyQueryFilters(entries, parsed);
    expect(result).toHaveLength(4);
  });

  it('filters by exact term (case-insensitive)', () => {
    const parsed: ParsedQuery = {
      terms: [],
      exactTerms: ['OWASP'],
      prefixTerms: [],
      excludeTerms: [],
      filters: {},
    };
    const result = applyQueryFilters(entries, parsed);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('security-scan');
  });

  it('filters by prefix term on name', () => {
    const parsed: ParsedQuery = {
      terms: [],
      exactTerms: [],
      prefixTerms: ['deploy'],
      excludeTerms: [],
      filters: {},
    };
    const result = applyQueryFilters(entries, parsed);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('deploy-server');
  });

  it('filters by prefix term on description', () => {
    const parsed: ParsedQuery = {
      terms: [],
      exactTerms: [],
      prefixTerms: ['Starts'],
      excludeTerms: [],
      filters: {},
    };
    const result = applyQueryFilters(entries, parsed);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('prefix-match');
  });

  it('excludes entries containing the exclude term', () => {
    const parsed: ParsedQuery = {
      terms: [],
      exactTerms: [],
      prefixTerms: [],
      excludeTerms: ['browser'],
      filters: {},
    };
    const result = applyQueryFilters(entries, parsed);
    expect(result).toHaveLength(3);
    expect(result.find((e) => e.name === 'browse')).toBeUndefined();
  });

  it('applies multiple filters together', () => {
    const parsed: ParsedQuery = {
      terms: [],
      exactTerms: ['deploy'],
      prefixTerms: [],
      excludeTerms: ['production'],
      filters: {},
    };
    // "deploy-server" has "deploy" in name but "production" in description → excluded
    const result = applyQueryFilters(entries, parsed);
    expect(result).toHaveLength(0);
  });
});
