import { describe, it, expect, afterEach } from 'vitest';
import matter from 'gray-matter';
import { parseStrict } from '../parsers/frontmatter-recovery.js';
import { AliasLimitError, MAX_ALIAS_NODES } from '../parsers/yaml-alias-meter.js';
import { parseFrontmatter } from '../parsers/utils.js';
import { aliasBomb } from './hostile-claude-dir.js';

/**
 * The meter rests on three things js-yaml does: it calls a `listener` option for every node it
 * composes; it leaves `kind` and `tag` null on a node it filled by looking an anchor up; and it
 * reads a block entry that starts with an alias twice. The first cases pin those behaviours of the
 * installed gray-matter and js-yaml, so an upgrade that changes one fails here and not in the field.
 */

interface LoaderEvent {
  readonly event: string;
  readonly kind: string | null;
  readonly tag: string | null;
  readonly result: unknown;
  readonly position: number;
}

type YamlParse = (text: string, options?: object) => unknown;

const yamlEngine = (matter as unknown as { engines: { yaml: { parse: YamlParse } } }).engines.yaml;
const originalParse = yamlEngine.parse;

afterEach(() => {
  yamlEngine.parse = originalParse;
});

function framed(frontmatter: string): string {
  return `---\n${frontmatter}\n---\nbody\n`;
}

function trace(text: string): LoaderEvent[] {
  const events: LoaderEvent[] = [];
  const listener = (event: string, state: Omit<LoaderEvent, 'event'>) => {
    const { kind, tag, result, position } = state;
    events.push({ event, kind, tag, result, position });
  };
  yamlEngine.parse(text, { listener });
  return events;
}

describe('what the meter relies on in js-yaml', () => {
  it('gray-matter exposes its YAML engine, and js-yaml reports nodes to a listener', () => {
    const events = trace('a: &x [1, 2]\nb: 7\n');

    expect(typeof yamlEngine.parse).toBe('function');
    expect(events.some((e) => e.event === 'open')).toBe(true);
    expect(events.filter((e) => e.event === 'close' && e.kind === 'mapping')).toHaveLength(1);
    expect(events.filter((e) => e.event === 'close' && e.kind === 'sequence')).toHaveLength(1);
  });

  it('leaves kind and tag null on an alias node, with the anchored value as its result', () => {
    const closes = trace('a: &x hello\nb: *x\n').filter((e) => e.event === 'close');

    const aliases = closes.filter((e) => e.kind === null && e.tag === null && e.result !== null);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].result).toBe('hello');
  });

  it('reports an alias that starts a block entry twice, at the same offset', () => {
    const closes = trace('a: &x hello\nlist:\n  - *x\n').filter(
      (e) => e.event === 'close' && e.kind === null && e.tag === null && e.result === 'hello',
    );

    expect(closes).toHaveLength(2);
    expect(new Set(closes.map((e) => e.position)).size).toBe(1);
  });
});

describe('the alias count', () => {
  it('allows exactly MAX_ALIAS_NODES aliases', () => {
    expect(MAX_ALIAS_NODES).toBe(1);
    const parsed = parseStrict(framed('s: &s [1, 2]\none: *s'));

    expect(parsed.data).toEqual({ s: [1, 2], one: [1, 2] });
  });

  it('counts an alias at the start of a block entry once, though the engine reads it twice', () => {
    const parsed = parseStrict(framed('s: &s hello\nlist:\n  - *s\n  - plain'));

    expect(parsed.data).toEqual({ s: 'hello', list: ['hello', 'plain'] });
  });

  it('stops the parse at the second alias with an AliasLimitError that names the count', () => {
    expect(() => parseStrict(framed('s: &s [1]\none: *s\ntwo: *s'))).toThrow(AliasLimitError);
    try {
      parseStrict(framed('s: &s [1]\none: *s\ntwo: *s'));
    } catch (error) {
      expect((error as AliasLimitError).aliases).toBe(2);
    }
  });

  it('counts two aliases written at block-entry positions as two', () => {
    expect(() => parseStrict(framed('s: &s hello\nlist:\n  - *s\n  - *s'))).toThrow(
      AliasLimitError,
    );
  });

  it('does not count aliases of nothing: a null or an empty string repeats no value', () => {
    const parsed = parseStrict(
      framed('n: &n ~\ne: &e ""\na: *n\nb: *n\nc: *e\nd: *e\nf: *e\ng: *n'),
    );

    expect(parsed.data).toMatchObject({ a: null, b: null, c: '', d: '' });
  });

  it('does not count a tagged empty node as an alias', () => {
    const parsed = parseStrict(
      framed('a: !!map\nb: !!map\nc: !!str\nd: !!str\ne: !!seq\nf: !!seq'),
    );

    expect(parsed.data).toMatchObject({ a: {}, b: {}, c: '', d: '', e: [], f: [] });
  });

  it('does not meter the JSON engine, which has no aliases', () => {
    const parsed = parseStrict('---json\n{"a": [1, 2], "b": {"c": 3}}\n---\nbody');

    expect(parsed.data).toEqual({ a: [1, 2], b: { c: 3 } });
  });
});

describe('failing closed', () => {
  it('refuses a parse in which the engine reported no node at all', () => {
    yamlEngine.parse = (text) => originalParse(text);

    expect(() => parseStrict(framed('a: 1'))).toThrow(/did not report its nodes/);
  });

  it('never hands back the expansion of a bomb when the engine stops reporting', () => {
    yamlEngine.parse = (text) => originalParse(text);

    const result = parseFrontmatter(aliasBomb('allowed-tools'));

    expect(result.recovery).toBe('line-based');
    expect(result.data).toEqual({ name: 'laughs', description: 'billion laughs' });
  });

  it('refuses every parse when gray-matter stops exposing its YAML engine', () => {
    const engines = (matter as unknown as { engines: { yaml?: unknown } }).engines;
    const saved = engines.yaml;
    engines.yaml = undefined;
    try {
      expect(() => parseStrict(framed('a: 1'))).toThrow(/exposes no YAML engine/);
    } finally {
      engines.yaml = saved;
    }
  });
});

describe('the recovery parse is metered too', () => {
  // js-yaml fails on the argument hint before it reaches any alias; the recovery quotes that line
  // and parses again, and only then meets the aliases. A guard that looked at the first parse alone
  // would let the second one expand them.
  it('skips a block whose aliases only the recovery parse reaches', () => {
    const text = 'x'.repeat(200);
    const raw = framed(
      `name: hinted\nargument-hint: [a] [b]\ns: &s "${text}"\none: *s\ntwo: *s\nthree: *s`,
    );

    const result = parseFrontmatter(raw);

    expect((result.recoveryCause as Error).message).toBe('frontmatter skipped: aliases');
    expect(result.recovery).toBe('line-based');
    expect(result.data).toEqual({ name: 'hinted' });
  });

  it('still recovers a hint-style block with a single alias, through the quoting', () => {
    const raw = framed('name: hinted\nargument-hint: [a] [b]\ns: &s hello\none: *s');

    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('quoted');
    expect(result.data.one).toBe('hello');
  });
});
