import { describe, it, expect } from 'vitest';
import type { VaultEntry } from '../types/index.js';
import {
  dedupeEntriesById,
  partitionValidEntries,
  runParserSafely,
  validateEntry,
} from '../scan-pipeline.js';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'aaaaaaaaaaaa',
    name: 'thing',
    type: 'skill',
    source: 'custom',
    description: 'a thing',
    filePath: '/claude/skills/thing/SKILL.md',
    tags: ['thing'],
    metadata: {},
    content: 'body',
    lastModified: new Date('2025-01-01T00:00:00.000Z'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

describe('runParserSafely', () => {
  it('passes a healthy result through unchanged', async () => {
    const entry = makeEntry();
    const result = await runParserSafely('skill', '/claude/skills', async () => ({
      entries: [entry],
      errors: [{ filePath: '/x', message: 'warn' }],
    }));

    expect(result.entries).toEqual([entry]);
    expect(result.errors).toEqual([{ filePath: '/x', message: 'warn' }]);
  });

  it('converts a synchronous throw into a ParseError attributed to the parser', async () => {
    const cause = new TypeError('boom');
    const result = await runParserSafely('hook', '/claude/settings.json', () => {
      throw cause;
    });

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      filePath: '/claude/settings.json',
      parser: 'hook',
      cause,
    });
    expect(result.errors[0].message).toContain('boom');
  });

  it('converts a rejected promise into a ParseError, including non-Error rejections', async () => {
    const result = await runParserSafely('plugin', '/claude/plugins', () =>
      Promise.reject('plain string'),
    );

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('plain string');
  });

  it('rejects results that are not a ParserResult without throwing', async () => {
    const result = await runParserSafely('rule', '/claude/rules', async () => null as never);

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].parser).toBe('rule');
  });

  it('drops malformed entries from an otherwise healthy result and keeps the valid ones', async () => {
    const good = makeEntry({ id: 'bbbbbbbbbbbb' });
    const result = await runParserSafely('skill', '/claude/skills', async () => ({
      entries: [good, { id: 7 } as unknown as VaultEntry],
      errors: [],
    }));

    expect(result.entries).toEqual([good]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].parser).toBe('skill');
  });
});

describe('validateEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(validateEntry(makeEntry())).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'entry'],
    ['an array', []],
    ['a missing id', makeEntry({ id: undefined as unknown as string })],
    ['an empty id', makeEntry({ id: '' })],
    ['an unknown type', makeEntry({ type: 'widget' as VaultEntry['type'] })],
    ['a non-string name', makeEntry({ name: 5 as unknown as string })],
    ['non-array tags', makeEntry({ tags: 'a,b' as unknown as string[] })],
    ['non-string tags', makeEntry({ tags: [1] as unknown as string[] })],
    ['null metadata', makeEntry({ metadata: null as unknown as Record<string, unknown> })],
    ['a string lastModified', makeEntry({ lastModified: '2025-01-01' as unknown as Date })],
    ['an invalid lastModified date', makeEntry({ lastModified: new Date('nope') })],
    ['a non-string filePath', makeEntry({ filePath: undefined as unknown as string })],
  ])('rejects %s with a reason', (_label, value) => {
    const reason = validateEntry(value);
    expect(typeof reason).toBe('string');
    expect(reason!.length).toBeGreaterThan(0);
  });
});

describe('partitionValidEntries', () => {
  it('splits valid records from invalid ones and reports each invalid record', () => {
    const good = makeEntry();
    const { valid, errors } = partitionValidEntries([good, null, { id: 'x' }], 'import');

    expect(valid).toEqual([good]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.parser === 'import')).toBe(true);
  });

  it('treats a non-array batch as one rejected record instead of throwing', () => {
    const { valid, errors } = partitionValidEntries('nope' as unknown as VaultEntry[], 'import');

    expect(valid).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('dedupeEntriesById', () => {
  it('keeps every entry when ids are already unique', () => {
    const a = makeEntry({ id: 'a' });
    const b = makeEntry({ id: 'b', filePath: '/claude/skills/b/SKILL.md' });

    const { entries, errors } = dedupeEntriesById([a, b]);

    expect(entries).toEqual([a, b]);
    expect(errors).toEqual([]);
  });

  it('keeps the first entry by sorted filePath and reports the loser', () => {
    const later = makeEntry({ id: 'dup', filePath: '/claude/skills/zeta/SKILL.md' });
    const earlier = makeEntry({ id: 'dup', filePath: '/claude/skills/alpha/SKILL.md' });

    const { entries, errors } = dedupeEntriesById([later, earlier]);

    expect(entries).toEqual([earlier]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(
      'duplicate id dup: /claude/skills/alpha/SKILL.md vs /claude/skills/zeta/SKILL.md',
    );
    expect(errors[0].filePath).toBe('/claude/skills/zeta/SKILL.md');
    expect(errors[0].parser).toBe('skill');
  });

  it('reports one error per dropped entry when three entries share an id', () => {
    const paths = ['/c', '/a', '/b'];
    const input = paths.map((filePath) => makeEntry({ id: 'dup', filePath }));

    const { entries, errors } = dedupeEntriesById(input);

    expect(entries.map((e) => e.filePath)).toEqual(['/a']);
    expect(errors.map((e) => e.filePath).sort()).toEqual(['/b', '/c']);
  });

  it('breaks filePath ties by input order so the outcome is deterministic', () => {
    const first = makeEntry({ id: 'dup', filePath: '/same', description: 'first' });
    const second = makeEntry({ id: 'dup', filePath: '/same', description: 'second' });

    const { entries } = dedupeEntriesById([first, second]);

    expect(entries).toEqual([first]);
  });

  it('does not mutate its input', () => {
    const input = [
      makeEntry({ id: 'dup', filePath: '/b' }),
      makeEntry({ id: 'dup', filePath: '/a' }),
    ];
    const snapshot = [...input];

    dedupeEntriesById(input);

    expect(input).toEqual(snapshot);
  });
});
