import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../parsers/utils.js';
import { expandedUnits, readWithOracle } from './yaml-alias-oracle.js';

/**
 * The alias guard may not be decided by reading the YAML text. A scanner over the text loses to
 * quoting: a token inside a quoted key looks like an anchor or an alias and swallows the quote that
 * the real one needs as its context, so real aliases go unseen (hidden), while tokens that sit in
 * comments, block scalars and quoted strings look real and cost a benign file its frontmatter
 * (false alarms). The guard counts the alias nodes the YAML engine itself resolves, so every shape
 * below is decided by what js-yaml does with it, and the oracle (which watches js-yaml's anchor
 * table, not its node kinds) says what that is.
 */

const KIB = 1024;
const SIZE_FACTOR = 4;
const SIZE_SLACK = 256;
const LONG = 'x'.repeat(200);
const COPIES = 12;
// Aliases of an anchor that is declared once: enough to expand well past the size budget.
const MANY = 40;
const ENGINE_NAME = 'evasion';
const ENGINE_DESCRIPTION = 'evades the guard';

function document(lines: readonly string[], eol = '\n'): string {
  const head = [`name: ${ENGINE_NAME}`, `description: ${ENGINE_DESCRIPTION}`];
  return ['---', ...head, ...lines, '---', 'body', ''].join(eol);
}

function copies(item: (index: number) => string, count = COPIES, joiner = ', '): string {
  return Array.from({ length: count }, (_, index) => item(index)).join(joiner);
}

/** `count` references to anchor `name`, written as a flow sequence body. */
function refs(name: string, count = COPIES): string {
  return copies(() => `*${name}`, count);
}

/**
 * A flow mapping whose keys hold `fake` (an alias or anchor look-alike) just before the closing
 * quote, so a token scanner's name run swallows the quote the next token needs as its context.
 */
function fakeKeyMap(
  fake: string,
  quote: string,
  separator: string,
  value: string,
  count = COPIES,
): string {
  const pairs = copies((i) => `${quote}${fake}${i}${quote}${separator}${value}`, count);
  return `{${pairs}}`;
}

interface Shape {
  readonly name: string;
  readonly raw: string;
}

// Real amplifiers that a text scanner cannot see: the alias or its anchor is hidden behind a
// look-alike token inside a quoted key.
const HIDDEN_SHAPES: readonly Shape[] = [
  {
    name: 'reported: fake alias in a double-quoted key swallows the quote before the real alias',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap(' *k', '"', ' :', '*s')}`]),
  },
  {
    name: 'reported: fake anchor in a double-quoted key hides the real anchor',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', ' :', `&s "${LONG}"`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake alias in single-quoted keys',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap(' *k', "'", ' :', '*s')}`]),
  },
  {
    name: 'fake alias in double-quoted keys, colon touching the quote',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap(' *k', '"', ':', '*s')}`]),
  },
  {
    name: 'fake alias in double-quoted keys, a tab before the colon',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap(' *k', '"', '\t:', '*s')}`]),
  },
  {
    name: 'fake alias after a comma inside the key',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap('a,*k', '"', ' :', '*s')}`]),
  },
  {
    name: 'fake alias after other words inside the key',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap('some words *k', '"', ' :', '*s')}`]),
  },
  {
    name: 'fake alias after a non-ASCII word inside the key',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap('é 日本 *k', '"', ' :', '*s')}`]),
  },
  {
    name: 'fake alias after an escaped quote inside a double-quoted key',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap('\\" *k', '"', ' :', '*s')}`]),
  },
  {
    name: 'fake alias after a doubled quote inside a single-quoted key',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap("it''s *k", "'", ' :', '*s')}`]),
  },
  {
    name: 'fake alias in keys of flow mappings inside a flow sequence',
    raw: document([`s: &s "${LONG}"`, `m: [${fakeKeyMap(' *k', '"', ' :', '*s')}]`]),
  },
  {
    name: 'fake alias in keys, the aliases written in CRLF lines',
    raw: document([`s: &s "${LONG}"`, `m: ${fakeKeyMap(' *k', '"', ' :', '*s')}`], '\r\n'),
  },
  {
    name: 'fake anchor in single-quoted keys hides the real anchor',
    raw: document([
      `m: ${fakeKeyMap(' &z', "'", ' :', `&s "${LONG}"`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor in keys, colon touching the quote',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', ':', `&s "${LONG}"`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor in keys, a tab before the colon',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', '\t:', `&s "${LONG}"`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor after other words inside the key',
    raw: document([
      `m: ${fakeKeyMap('words *and &z', '"', ' :', `&s "${LONG}"`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor after a bracket inside the key',
    raw: document([
      `m: ${fakeKeyMap('[&z', '"', ' :', `&s "${LONG}"`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor in keys, the real anchor on a sequence',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', ' :', `&s ["${LONG}", "${LONG}"]`, 1)}`,
      `r: [${refs('s', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor in keys of a flow mapping nested in a sequence',
    raw: document([
      `m: [${fakeKeyMap(' &z', '"', ' :', `&s "${LONG}"`, 1)}]`,
      `r: [[${refs('s', 12)}], [${refs('s', 12)}]]`,
    ]),
  },
  {
    name: 'fake anchor in keys, the aliases written with tabs',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', ' :', `&s "${LONG}"`, 1)}`,
      `r:\t[${copies(() => '*s', MANY, ',\t')}]`,
    ]),
  },
  {
    name: 'fake anchor in keys, CRLF lines',
    raw: document(
      [`m: ${fakeKeyMap(' &z', '"', ' :', `&s "${LONG}"`, 1)}`, `r: [${refs('s', MANY)}]`],
      '\r\n',
    ),
  },
  {
    name: 'fake anchor in keys, a merge key aliasing the hidden anchor',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', ' :', `&s {k: "${LONG}"}`, 1)}`,
      `r: [${copies(() => '{<<: *s}', MANY)}]`,
    ]),
  },
  {
    name: 'fake anchor in keys, the real anchor named in non-ASCII',
    raw: document([
      `m: ${fakeKeyMap(' &z', '"', ' :', `&日本 "${LONG}"`, 1)}`,
      `r: [${refs('日本', MANY)}]`,
    ]),
  },
];

// Real amplifiers a text scanner does see; they must stay refused whatever the parser changes.
const VISIBLE_SHAPES: readonly Shape[] = [
  {
    name: 'plain anchor and flow-sequence aliases',
    raw: document([`s: &s "${LONG}"`, `r: [${refs('s')}]`]),
  },
  {
    name: 'aliases as block sequence items',
    raw: document([`s: &s "${LONG}"`, 'r:', ...Array.from({ length: COPIES }, () => '  - *s')]),
  },
  {
    name: 'anchors on mapping keys, aliased as keys',
    raw: document([`&k "${LONG}": 1`, `r: [${copies(() => '{*k : 1}')}]`]),
  },
  {
    name: 'merge keys',
    raw: document([`base: &base {k: "${LONG}"}`, `r: [${copies(() => '{<<: *base}')}]`]),
  },
  {
    name: 'a merge sequence',
    raw: document([
      `base: &base {k: "${LONG}"}`,
      `r: [${copies(() => '{<<: [*base, *base]}', 30)}]`,
    ]),
  },
  {
    name: 'nested flow sequences',
    raw: document([
      `s: &s "${LONG}"`,
      `r: [[[${refs('s', 4)}], [${refs('s', 4)}]], [[${refs('s', 4)}], [${refs('s', 4)}]]]`,
    ]),
  },
  {
    name: 'a non-ASCII anchor name',
    raw: document([`s: &日本語 "${LONG}"`, `r: [${refs('日本語')}]`]),
  },
  {
    name: 'anchor names made of punctuation, quotes and colons',
    raw: document([`s: &a:b"c.d-e "${LONG}"`, `r: [${refs('a:b"c.d-e')}]`]),
  },
  {
    name: 'an anchor named with a leading star',
    raw: document([`s: &*s "${LONG}"`, `r: [${refs('*s')}]`]),
  },
  {
    name: 'tabs between the aliases',
    raw: document([`s: &s "${LONG}"`, `r:\t[${copies(() => '*s', COPIES, ',\t')}]`]),
  },
  {
    name: 'CRLF lines',
    raw: document([`s: &s "${LONG}"`, `r: [${refs('s')}]`], '\r\n'),
  },
  {
    name: 'an anchor on its own line before its value',
    raw: document([`s: &s`, `  k: "${LONG}"`, `r: [${refs('s')}]`]),
  },
  {
    name: 'a core-schema tag before the anchor',
    raw: document([`s: !!str &s "${LONG}"`, `r: [${refs('s')}]`]),
  },
  {
    name: 'an explicit key with an alias',
    raw: document([`s: &s "${LONG}"`, `r: {${copies((i) => `? k${i}\n: *s`, COPIES, ',\n')}}`]),
  },
  {
    name: 'the aliases of an anchor that holds another alias',
    raw: document([`a: &a ["${LONG}"]`, `b: &b [*a, *a]`, `r: [${copies(() => '*b', 8)}]`]),
  },
  {
    name: 'a quoted-key look-alike next to the real aliases',
    raw: document([`s: &s "${LONG}"`, `r: {"a *s": 1}`, `q: [${refs('s')}]`]),
  },
];

// Text that looks like anchors and aliases to a scanner but is not a node for the engine.
const LOOK_ALIKES: readonly Shape[] = [
  {
    name: 'tokens in a trailing comment',
    raw: document([`s: &s "${LONG}"`, 'note: 1 # *s *s *s *s']),
  },
  {
    name: 'tokens in a comment line',
    raw: document([`s: &s "${LONG}"`, '# see *s and *s and *s', 'n: 1']),
  },
  {
    name: 'tokens in a literal block scalar',
    raw: document([`s: &s "${LONG}"`, 'notes: |', '  uses &s then *s and *s', '  and *s']),
  },
  {
    name: 'tokens in a folded block scalar',
    raw: document([`s: &s "${LONG}"`, 'notes: >', '  uses &s then *s and *s', '  and *s']),
  },
  {
    name: 'tokens in a double-quoted string',
    raw: document([`s: &s "${LONG}"`, 'notes: "text *s and *s and *s"']),
  },
  {
    name: 'tokens in a single-quoted string',
    raw: document([`s: &s "${LONG}"`, "notes: 'text *s and *s and *s'"]),
  },
  {
    name: 'tokens in a plain scalar',
    raw: document([`s: &s "${LONG}"`, 'notes: see *s and *s and *s']),
  },
  {
    name: 'tokens in a quoted key',
    raw: document([`s: &s "${LONG}"`, 'notes: {"a *s": 1, "b *s": 2, "c *s": 3}']),
  },
  {
    name: 'an anchor token only in a string, with aliases of a real anchor beside it',
    raw: document([`s: &s "${LONG}"`, 'notes: "&t"', 'one: *s']),
  },
  {
    name: 'a tool pattern with stars and ampersands',
    raw: document([`s: &s "${LONG}"`, 'tools: Bash(git:*) && Bash(npm:*) and *.ts and *.js']),
  },
  {
    name: 'a URL fragment and a glob',
    raw: document([`s: &s "${LONG}"`, 'url: https://example.com/?a=1&s=2 and **/*.md']),
  },
];

function skipReason(raw: string): string | null {
  const { recoveryCause } = parseFrontmatter(raw);
  const message = (recoveryCause as Error | undefined)?.message ?? '';
  const match = /^frontmatter skipped: (\w+)$/.exec(message);
  return match === null ? null : match[1];
}

function sizeBudget(raw: string): number {
  return SIZE_FACTOR * raw.length + SIZE_SLACK;
}

describe('the alias guard is decided by the YAML engine, not by the text', () => {
  describe.each([
    ['aliases a text scanner cannot see', HIDDEN_SHAPES],
    ['aliases a text scanner sees', VISIBLE_SHAPES],
  ])('%s', (_label, shapes) => {
    it.each(shapes.map((shape) => [shape.name, shape.raw] as const))(
      'skips the frontmatter of: %s',
      (_name, raw) => {
        // The shape is a real amplifier: the engine parses it, resolves many aliases and the
        // expanded tree is far larger than the text.
        const reading = readWithOracle(raw);
        expect(reading.parsed).toBe(true);
        expect(reading.valueAliases).toBeGreaterThanOrEqual(2);
        expect(expandedUnits(reading.data, 10 * sizeBudget(raw))).toBeGreaterThan(sizeBudget(raw));

        const result = parseFrontmatter(raw);

        expect(skipReason(raw)).toBe('aliases');
        expect(result.recovery).toBe('line-based');
        expect(result.data).toEqual({ name: ENGINE_NAME, description: ENGINE_DESCRIPTION });
        expect(JSON.stringify(result.data).length).toBeLessThan(KIB);
      },
    );
  });

  describe('text that only looks like anchors and aliases', () => {
    it.each(LOOK_ALIKES.map((shape) => [shape.name, shape.raw] as const))(
      'keeps the whole frontmatter of: %s',
      (_name, raw) => {
        const reading = readWithOracle(raw);
        expect(reading.parsed).toBe(true);
        expect(reading.valueAliases).toBeLessThanOrEqual(1);

        const result = parseFrontmatter(raw);

        expect(skipReason(raw)).toBeNull();
        expect(result.recovery).toBeUndefined();
        expect(result.data.name).toBe(ENGINE_NAME);
        expect(result.data.s).toBe(LONG);
        expect(JSON.parse(JSON.stringify(result.data))).toEqual(
          JSON.parse(JSON.stringify(reading.data)),
        );
      },
    );
  });

  it('lets one alias through: it can at most double what it points at', () => {
    const raw = document([`s: &s "${LONG}"`, 'one: *s']);

    const result = parseFrontmatter(raw);

    expect(skipReason(raw)).toBeNull();
    expect(result.data.one).toBe(LONG);
    expect(result.data.s).toBe(LONG);
  });

  it('refuses the second alias', () => {
    const raw = document([`s: &s "${LONG}"`, 'one: *s', 'two: *s']);

    expect(skipReason(raw)).toBe('aliases');
  });
});
