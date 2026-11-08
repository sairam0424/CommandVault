import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../parsers/utils.js';
import { BENIGN_ALIAS_LOOKALIKES, skillWithTools } from './hostile-claude-dir.js';
import { expandedUnits, hasCycle, readWithOracle } from './yaml-alias-oracle.js';

/**
 * A differential test for the alias guard: thousands of small documents drawn from a seeded
 * grammar that puts anchors, aliases, merge keys, tags, comments, block scalars and look-alike
 * tokens in every place YAML allows them, each judged twice. The oracle parses the block with the
 * real engine and no guard, counts the aliases it resolves and expands the result as a tree; the
 * pipeline (`parseFrontmatter`) says whether it kept the frontmatter. They must agree:
 *   - whenever the real parser would expand the block past the size budget, the pipeline refuses;
 *   - the pipeline refuses exactly the blocks in which the engine resolves a second alias;
 *   - a block the engine parses with at most one alias is kept, with the data the engine built.
 */

const SIZE_FACTOR = 4;
const SIZE_SLACK = 256;
const SIZE_SCAN_FACTOR = 20;
const DOCUMENTS_PER_SEED = 4000;
const SEEDS = [20260101, 7, 424242] as const;

type Random = () => number;

/** mulberry32: a small seeded generator, so a failing document can be rebuilt from its seed. */
function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ANCHOR_NAMES = [
  'a',
  'b',
  's',
  'l0',
  'x1',
  'é',
  '日本',
  'a-b',
  'a.b',
  'a:b',
  'q"r',
  '*s',
  '&t',
  "it's",
];
const WORDS = [
  'alpha',
  'beta',
  'Bash(git:*)',
  'a&b',
  '*.ts',
  '**/*.md',
  'x y z',
  '1',
  '2.5',
  'true',
];
const FAKE_TOKENS = [' *k', ' &z', ',*k', '[&z', 'a *k', 'é *k', '*k', '&z'];
const QUOTES = ['"', "'"] as const;
const SEPARATORS = [':', ' :', '\t:', '  :'] as const;
const LONG = 'x'.repeat(120);
const VERBATIM_SEQ_TAG = '!<tag:yaml.org,2002:seq>';

interface Generator {
  readonly random: Random;
  /** Names usable as aliases so far, in document order, and whether each names a mapping. */
  readonly anchors: { readonly name: string; readonly isMapping: boolean }[];
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function chance(random: Random, probability: number): boolean {
  return random() < probability;
}

function scalar(g: Generator): string {
  const r = g.random;
  switch (Math.floor(r() * 8)) {
    case 0:
      return pick(r, WORDS);
    case 1:
      return `"${pick(r, WORDS)} *${pick(r, ANCHOR_NAMES)} &${pick(r, ANCHOR_NAMES)}"`;
    case 2:
      return `'${pick(r, WORDS)} *${pick(r, ANCHOR_NAMES)}'`;
    case 3:
      return `"${LONG}"`;
    case 4:
      return pick(r, ['~', '""', '!!str ""']);
    case 5:
      return `text with *${pick(r, ANCHOR_NAMES)} and &${pick(r, ANCHOR_NAMES)} inside`;
    default:
      return String(Math.floor(r() * 100));
  }
}

/** The text of an alias: of a known anchor, or now and then of one nothing declares. */
function alias(g: Generator): string {
  const known = g.anchors.length > 0 && chance(g.random, 0.92);
  return `*${known ? pick(g.random, g.anchors).name : pick(g.random, ANCHOR_NAMES)}`;
}

/** An alias node: only once an anchor exists, since an alias of nothing is a YAML error. */
function aliasNode(g: Generator): string {
  return g.anchors.length > 0 || chance(g.random, 0.02) ? alias(g) : scalar(g);
}

/** An anchor on a sequence, a mapping or a scalar, with a tag that fits what it names. */
function anchored(g: Generator, depth: number): string {
  const r = g.random;
  const name = pick(r, ANCHOR_NAMES);
  const kind = Math.floor(r() * 3);
  const inner = [flowSeq, flowMap, scalar][kind](g, depth + 1);
  const fitting = ['!!seq ', '!!map ', '!!str '][kind];
  const tag = chance(r, 0.2) ? pick(r, [fitting, kind === 0 ? VERBATIM_SEQ_TAG : '']) : '';
  // The name is usable only after its node is complete (a node cannot hold its own alias here).
  g.anchors.push({ name, isMapping: kind === 1 });
  return `${tag}&${name} ${inner}`;
}

function flowKey(g: Generator, index: number): string {
  const r = g.random;
  if (chance(r, 0.4)) return `k${index}`;
  const quote = pick(r, QUOTES);
  const fake = chance(r, 0.6) ? pick(r, FAKE_TOKENS) : '';
  return `${quote}k${index}${fake}${quote}`;
}

function flowMap(g: Generator, depth: number): string {
  const r = g.random;
  const size = 1 + Math.floor(r() * 5);
  const pairs: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const mappings = g.anchors.filter((anchor) => anchor.isMapping);
    if (chance(r, 0.12) && mappings.length > 0) {
      pairs.push(`<<: *${pick(r, mappings).name}`);
      continue;
    }
    const key = flowKey(g, i);
    const quoted = key.startsWith('"') || key.startsWith("'");
    const separator = quoted ? pick(r, SEPARATORS) : ':';
    const gap = separator.endsWith(':') && quoted && chance(r, 0.5) ? '' : ' ';
    pairs.push(`${key}${separator}${gap}${value(g, depth + 1)}`);
  }
  return `{${pairs.join(', ')}}`;
}

function flowSeq(g: Generator, depth: number): string {
  const size = 1 + Math.floor(g.random() * 6);
  const items = Array.from({ length: size }, () => value(g, depth + 1));
  return `[${items.join(pick(g.random, [', ', ',', ',\t']))}]`;
}

function value(g: Generator, depth: number): string {
  const r = g.random;
  if (depth >= 3) return chance(r, 0.4) ? aliasNode(g) : scalar(g);
  switch (Math.floor(r() * 10)) {
    case 0:
    case 1:
      return aliasNode(g);
    case 2:
    case 3:
      return anchored(g, depth);
    case 4:
    case 5:
      return flowSeq(g, depth);
    case 6:
    case 7:
      return flowMap(g, depth);
    default:
      return scalar(g);
  }
}

function blockScalar(g: Generator): string[] {
  const indicator = pick(g.random, ['|', '>', '|-', '>+']);
  const lines = Array.from(
    { length: 1 + Math.floor(g.random() * 3) },
    () => `  uses ${alias(g)} and &${pick(g.random, ANCHOR_NAMES)} then ${alias(g)}`,
  );
  return [indicator, ...lines];
}

function entry(g: Generator, index: number): string[] {
  const r = g.random;
  const key = `e${index}`;
  if (index === 0) return [`${key}: ${anchored(g, 0)}`];
  const comment = chance(r, 0.15) ? ` # ${alias(g)} &c ${alias(g)}` : '';
  if (chance(r, 0.1)) {
    const [indicator, ...lines] = blockScalar(g);
    return [`${key}: ${indicator}`, ...lines];
  }
  if (chance(r, 0.1)) {
    const items = Array.from({ length: 1 + Math.floor(r() * 4) }, () => `  - ${value(g, 1)}`);
    return [`${key}:`, ...items];
  }
  return [`${key}: ${value(g, 0)}${comment}`];
}

/** A line that repeats a known anchor, the way an alias bomb does. */
function amplifier(g: Generator): string[] {
  const copies = 4 + Math.floor(g.random() * 12);
  const items = Array.from({ length: copies }, () => `*${pick(g.random, g.anchors).name}`);
  const body = pick(g.random, [`[${items.join(', ')}]`, `[[${items.join(', ')}]]`]);
  return [`amp: ${body}`];
}

function generateDocument(random: Random): string {
  const g: Generator = { random, anchors: [] };
  const eol = chance(random, 0.15) ? '\r\n' : '\n';
  const count = 2 + Math.floor(random() * 5);
  const lines: string[] = ['name: generated', 'description: a generated document'];
  for (let i = 0; i < count; i += 1) lines.push(...entry(g, i));
  if (chance(random, 0.3)) lines.push(...amplifier(g));
  return ['---', ...lines, '---', 'body', ''].join(eol);
}

function sizeBudget(raw: string): number {
  return SIZE_FACTOR * raw.length + SIZE_SLACK;
}

function skipReason(raw: string): string | null {
  const message = (parseFrontmatter(raw).recoveryCause as Error | undefined)?.message ?? '';
  const match = /^frontmatter skipped: (\w+)$/.exec(message);
  return match === null ? null : match[1];
}

function tryParse(raw: string): ReturnType<typeof parseFrontmatter> | null {
  try {
    return parseFrontmatter(raw);
  } catch {
    // The engine rejected the block and nothing could be recovered: the file is not indexed.
    return null;
  }
}

interface Tally {
  documents: number;
  rejected: number;
  refused: number;
  keptWithOneAlias: number;
  keptWithoutAliases: number;
  keptCyclic: number;
  expandingRefused: number;
}

function judge(raw: string, tally: Tally): void {
  const reading = readWithOracle(raw);
  tally.documents += 1;
  if (!reading.parsed) {
    // Invalid for the engine: the recovery path decides, and it may only answer with a skip or a
    // recovered name and description (or nothing). It must not hang or hand back data it expanded.
    tally.rejected += 1;
    const recovered = tryParse(raw);
    if (recovered !== null) expect(JSON.stringify(recovered.data).length).toBeLessThan(4096);
    return;
  }
  const result = parseFrontmatter(raw);
  const refused = skipReason(raw) === 'aliases';
  // A node that contains its own alias cannot be expanded at all; the sanitizer cuts the loop.
  const cyclic = hasCycle(reading.data);
  const expanding =
    !cyclic && expandedUnits(reading.data, SIZE_SCAN_FACTOR * sizeBudget(raw)) > sizeBudget(raw);

  expect(refused, `refusal must follow the alias count\n${JSON.stringify(raw)}`).toBe(
    reading.valueAliases >= 2,
  );
  if (expanding) {
    tally.expandingRefused += 1;
    expect(refused, `an expanding block must be refused\n${JSON.stringify(raw)}`).toBe(true);
  }
  if (refused) {
    tally.refused += 1;
    expect(result.recovery).toBe('line-based');
    expect(JSON.stringify(result.data).length).toBeLessThan(4096);
    return;
  }
  if (reading.valueAliases === 1) tally.keptWithOneAlias += 1;
  else tally.keptWithoutAliases += 1;
  expect(result.recovery).toBeUndefined();
  if (cyclic) {
    tally.keptCyclic += 1;
    expect(JSON.stringify(result.data).length).toBeLessThan(sizeBudget(raw));
    return;
  }
  expect(
    JSON.parse(JSON.stringify(result.data)),
    `kept data must equal the engine's\n${JSON.stringify(raw)}`,
  ).toEqual(JSON.parse(JSON.stringify(reading.data)));
}

describe('differential: the pipeline against the real YAML engine', () => {
  it.each(SEEDS)('agrees with the oracle on %i generated documents', (seed) => {
    const random = seededRandom(seed);
    const tally: Tally = {
      documents: 0,
      rejected: 0,
      refused: 0,
      keptWithOneAlias: 0,
      keptWithoutAliases: 0,
      keptCyclic: 0,
      expandingRefused: 0,
    };

    for (let i = 0; i < DOCUMENTS_PER_SEED; i += 1) judge(generateDocument(random), tally);

    // The grammar must reach all three outcomes often, or the agreement above proves little.
    expect(tally.documents).toBe(DOCUMENTS_PER_SEED);
    expect(tally.refused).toBeGreaterThan(500);
    expect(tally.expandingRefused).toBeGreaterThan(50);
    expect(tally.keptWithOneAlias).toBeGreaterThan(100);
    expect(tally.keptWithoutAliases).toBeGreaterThan(150);
    expect(tally.keptCyclic).toBeGreaterThan(0);
    expect(tally.rejected).toBeGreaterThan(100);
  });
});

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function markdownFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return markdownFilesUnder(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

// Frontmatter as the tools write it: arrays in both styles, block scalars, quoted values, tool
// patterns with stars, argument hints that are not valid YAML, comments, and unusual keys.
const REALISTIC_FRONTMATTER = [
  'name: code-reviewer\ndescription: Reviews code for quality, security and maintainability.\nallowed-tools: Bash, Read, Grep\nmodel: sonnet',
  'name: deploy\ndescription: "Deploy the app: staging first, then production"\nargument-hint: [environment] [--dry-run]\nallowed-tools: [Bash(git:*), Bash(npm:*), Read]',
  'description: |\n  Multi-line description that mentions &&, *.ts globs and Q&A.\n  Second line with * and & in prose.\nglobs: ["**/*.ts", "**/*.tsx"]\nalwaysApply: false',
  'name: plan\ndescription: >\n  Folded text over\n  two lines\ntools:\n  - Read\n  - Grep\n  - Glob\nmodel: opus\ncolor: "#FF5733"',
  '# a leading comment with &anchor and *alias tokens\nname: commented\ndescription: Has comments # not a comment inside quotes\ntriggers:\n  - lint\n  - format',
  'name: stars\ndescription: Lint *.ts and *.js files, search & replace\nallowed-tools: "Bash(*), Read"',
  "name: quoted\ndescription: 'It''s quoted; it has: colons'\nkeywords: [a, b, c]\nversion: 1.2.3",
  'name: unicode-日本語\ndescription: Résumé and naïve café\nemoji: "🧪"',
  'name: single-anchor\ndescription: one reuse is fine\nbase: &base shared value\ncopy: *base',
  'name: nested\ndescription: nested data\nconfig:\n  retries: 3\n  hooks:\n    pre: [lint, test]\n    post: [report]',
  'description: Uses tabs\nkeys:\t[a, b]',
  'name: dates\ndescription: has dates\nupdated: 2026-11-08\ncreated: 2026-01-01T10:00:00Z',
] as const;

function framed(frontmatter: string, eol = '\n'): string {
  return `---\n${frontmatter}\n---\nBody text.\n`.replace(/\n/g, eol);
}

describe('no false refusals on realistic frontmatter', () => {
  it.each(REALISTIC_FRONTMATTER.map((frontmatter) => [frontmatter.slice(0, 40), frontmatter]))(
    'keeps the frontmatter of: %s',
    (_label, frontmatter) => {
      for (const eol of ['\n', '\r\n']) {
        const raw = framed(frontmatter, eol);

        expect(skipReason(raw)).toBeNull();
      }
    },
  );

  it('keeps the frontmatter of every markdown fixture in the repository', () => {
    const files = markdownFilesUnder(FIXTURES);
    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      expect(skipReason(raw), file).toBeNull();
    }
  });

  it('keeps the frontmatter of the benign alias look-alikes', () => {
    for (const skill of BENIGN_ALIAS_LOOKALIKES) {
      const raw = skillWithTools(skill);
      expect(skipReason(raw), skill.name).toBeNull();
      expect(parseFrontmatter(raw).recovery, skill.name).toBeUndefined();
    }
  });
});
