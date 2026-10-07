import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  MAX_COMMENT_STRIP_STEPS,
  MAX_FRONTMATTER_BLOCK_CHARS,
  MAX_FRONTMATTER_BLOCK_LINES,
  guardFrontmatter,
} from '../parsers/frontmatter-recovery.js';
import { parseFrontmatter } from '../parsers/utils.js';
import { parseSkills } from '../parsers/skill-parser.js';
import { FRONTMATTER_WARNING_TAG } from '../parsers/base-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';
import { cpuTimeMs } from './cpu-time.js';
import {
  BENIGN_ALIAS_LOOKALIKES,
  VERBATIM_SEQ_TAG,
  aliasBomb,
  flowMapBomb,
  skillWithTools,
} from './hostile-claude-dir.js';

/**
 * YAML aliases are references, so an alias bomb parses in no time and explodes later, in
 * `JSON.stringify(entry.metadata)` inside the index step, which runs after the parser isolation:
 * one 458-byte skill file took the whole scan down ("Invalid string length", 1.5 GiB). The guard
 * keeps such a block from becoming data: the size caps are judged from the raw text before any YAML
 * engine runs, and the aliases are counted by the engine itself while it parses
 * (yaml-alias-meter.ts), on the strict path and on the recovery path that re-runs YAML on the same
 * block. The file is still indexed under its name with a warning. A circular anchor needs only one
 * alias, so it parses; the sanitizer cuts the loop (see sanitize-frontmatter.test.ts).
 * `guardFrontmatter` answers what the pipeline decided.
 */

const KIB = 1024;
// U+3042 is three bytes in UTF-8: 30 000 of them are 90 000 bytes, 21 000 are 63 000 bytes.
const WIDE_CHAR = 'あ';
const WIDE_CHARS_OVER_BYTE_CAP = 30_000;
const WIDE_CHARS_UNDER_BYTE_CAP = 21_000;
const TIME_BUDGET_MS = 200;
const HEAP_BUDGET_BYTES = 50 * 1024 * 1024;
const MIB = 1024 * 1024;
// gray-matter's comment strip is quadratic in a run of blank lines: without the line cap the LF
// run below costs over four seconds of CPU, so a CPU budget (not wall time, which a loaded machine
// inflates) tells the two apart with room to spare.
const CPU_BUDGET_MS = 200;
// Blank-line runs under the 64 KiB byte cap: one-byte breaks, two-byte units, three-byte U+2028.
const ONE_BYTE_RUN = 65_500;
const TWO_BYTE_RUN = 32_000;
const THREE_BYTE_RUN = 20_000;
// The oversize recovery reads name and description from the first 64 KiB of a block; splitting a
// whole 32 MiB block into lines cost over 600 MiB of heap and seconds. Heap is the oracle that
// tells the bounded recovery from the unbounded one; the CPU budget also covers the search for the
// closer, which must not scan the block one candidate at a time.
const WHOLE_FILE_BLOCK_CHARS = 32 * MIB;
const OVERSIZE_HEAP_BUDGET_BYTES = 64 * MIB;
const OVERSIZE_CPU_BUDGET_MS = 500;
// The padded blocks below cost the unguarded strip 250-600 ms of CPU; guarded, a few milliseconds.
const STRIP_CPU_BUDGET_MS = 100;

/**
 * A block holding exactly `breaks` line breaks as gray-matter slices it: with no engine name after
 * `---` the opener's own line break stays in the block, so `name: x` is followed by one fewer
 * repetition of `unit` than that, then the closer.
 */
function blankLineBlock(unit: string, breaks: number): string {
  return `---\nname: x${unit.repeat(breaks - 1)}\n---\nbody`;
}

// The case frontmatter-recovery.test.ts protects: one anchor reused once is legitimate YAML.
const SINGLE_ALIAS =
  '---\nname: alias\nbase: &base shared\ncopy: *base\nargument-hint: [a] [b]\n---\nBody';

// gray-matter reads the whole rest of the opener line as the engine name and trims it with
// String.prototype.trim, so every Unicode white space, and a bare CR, may surround it. Written as
// escapes: an invisible literal would not survive a review. (aliasBomb adds the newline.)
const TRIMMED_OPENERS = [
  ['a no-break space before the name', '---\u00A0yaml'],
  ['a no-break space after the name', '---yaml\u00A0'],
  ['a vertical tab', '---\u000Byaml'],
  ['a form feed', '---\u000Cyaml'],
  ['a line separator', '---\u2028yaml'],
  ['an ideographic space', '---\u3000yaml'],
  ['a zero-width no-break space after the name', '---yaml\uFEFF'],
  ['a zero-width no-break space before the name', '---\uFEFFyaml'],
  ['a tab and a space', '---\t yaml'],
  ['a bare carriage return after the name', '---yaml\r\r'],
  ['a bare carriage return and nothing else', '---\r\r'],
  ['white space and nothing else', '--- '],
] as const;

// Claude Code's tool-permission syntax: `:*` inside a plain scalar, next to an anchor-shaped typo.
const COLON_STAR_TOOLS =
  '---\nallowed-tools: Bash(git:*), Bash(npm:*)\ndescription: build &deploy\n---\nbody';

/** True when gray-matter itself hands the block to js-yaml: the contract the guard mirrors. */
function grayMatterParsesYaml(raw: string): boolean {
  return 'triggers' in matter(raw, {}).data;
}

describe('guardFrontmatter', () => {
  it('flags the 8-level alias bomb as aliases', () => {
    expect(guardFrontmatter(aliasBomb('allowed-tools'))).toBe('aliases');
  });

  // gray-matter lowercases the engine name before looking it up.
  it.each(['---yaml', '--- yaml', '---YAML', '---Yml', '--- YAML', '---YML'])(
    'flags the same bomb behind a %s opener, which gray-matter accepts',
    (opener) => {
      expect(guardFrontmatter(aliasBomb('triggers', opener))).toBe('aliases');
    },
  );

  // The alias count is the YAML engine's, so a bomb behind an engine that is not YAML never meets
  // an alias: gray-matter hands the JSON engine text it cannot parse, and throws before any parse on
  // a name it does not know. Nothing expands; the file is left unindexed with an error, as before
  // the guard existed. (An earlier text scan flagged these without asking an engine.)
  it.each(['---json', '---foo', '---foo bar', '---yaml#'])(
    'builds no data for a bomb behind a %s opener, an engine that cannot expand it',
    (opener) => {
      const raw = aliasBomb('triggers', opener);

      expect(guardFrontmatter(raw)).toBeNull();
      expect(() => parseFrontmatter(raw)).toThrow();
    },
  );

  it.each(TRIMMED_OPENERS)(
    'flags the bomb behind an opener with %s, which gray-matter trims away',
    (_what, opener) => {
      const raw = aliasBomb('triggers', opener);
      expect(grayMatterParsesYaml(raw)).toBe(true);
      expect(guardFrontmatter(raw)).toBe('aliases');
    },
  );

  it('flags an alias DAG written as flow mappings whose quoted keys touch their values', () => {
    const raw = flowMapBomb('triggers');
    expect(grayMatterParsesYaml(raw)).toBe(true);
    expect(guardFrontmatter(raw)).toBe('aliases');
  });

  // js-yaml skips separation space after a JSON-like key before it looks for the colon, then
  // takes the value with no space: the DAG reaches the engine with these just as it does with `:`.
  it.each([
    ['a space before each colon', ' :'],
    ['a tab before each colon', '\t:'],
    ['two spaces before each colon', '  :'],
  ])('flags the same DAG written with %s', (_what, sep) => {
    const raw = flowMapBomb('triggers', sep);
    expect(grayMatterParsesYaml(raw)).toBe(true);
    expect(guardFrontmatter(raw)).toBe('aliases');
  });

  it.each([
    [
      'flow-sequence keys with a space before the colon',
      '---\nname: n\na: &a [1]\nb: {[x] :*a, [y] :*a}\ntriggers: *a\n---\nbody',
    ],
    [
      'explicit pairs whose colon starts the next line',
      '---\nname: n\na: &a [1]\nb: {? "k"\n:*a, ? "j"\n:*a}\ntriggers: *a\n---\nbody',
    ],
  ])('flags aliases after %s, which js-yaml accepts', (_what, raw) => {
    expect(grayMatterParsesYaml(raw)).toBe(true);
    expect(guardFrontmatter(raw)).toBe('aliases');
  });

  // js-yaml reads tag and anchor properties in a loop with no separation space required between
  // them, so `!<...>&a` declares the anchor `a` just as ` &a` does.
  it.each([
    [
      'a verbatim tag before the anchor',
      '---\nname: n\na: !<tag:yaml.org,2002:seq>&a [1]\nb: [*a, *a]\ntriggers: *a\n---\nbody',
    ],
    [
      'a verbatim tag before an anchor inside a flow sequence',
      '---\nname: n\nb: [!<tag:yaml.org,2002:seq>&a [1], *a, *a]\ntriggers: *a\n---\nbody',
    ],
    [
      'a verbatim map tag before the anchor',
      '---\nname: n\na: !<tag:yaml.org,2002:map>&a {x: 1}\nb: [*a, *a]\ntriggers: *a\n---\nbody',
    ],
  ])('flags aliases of an anchor declared after %s', (_what, raw) => {
    expect(grayMatterParsesYaml(raw)).toBe(true);
    expect(guardFrontmatter(raw)).toBe('aliases');
  });

  it('flags the 8-level alias bomb whose every anchor follows a verbatim tag', () => {
    const raw = aliasBomb('triggers', '---', 8, VERBATIM_SEQ_TAG);
    expect(grayMatterParsesYaml(raw)).toBe(true);
    expect(guardFrontmatter(raw)).toBe('aliases');
  });

  // Only js-yaml's separation space (space, tab, line break) ends a plain scalar.
  it.each([
    ['a no-break space', '\u00A0'],
    ['an ideographic space', '\u3000'],
  ])('does not flag stars after %s, which js-yaml keeps inside the scalar', (_what, space) => {
    const value = `x${space}*a${space}*a`;
    const raw = `---\na: &a 1\nb: ${value}\ntriggers: t\n---\nbody`;
    expect(matter(raw, {}).data.b).toBe(value);
    expect(guardFrontmatter(raw)).toBeNull();
  });

  it('flags a block over 64 KiB as oversize', () => {
    const raw = `---\nname: x\ndescription: d\nk: ${'v'.repeat(70 * KIB)}\n---\nbody\n`;
    expect(guardFrontmatter(raw)).toBe('oversize');
  });

  it.each(['---YAML', '---json', '---\u00A0yaml', '---\u000Byaml', '---\r\r'])(
    'flags a block over 64 KiB behind a %s opener as oversize',
    (opener) => {
      const raw = `${opener}\nname: x\nk: ${'v'.repeat(70 * KIB)}\n---\nbody\n`;
      expect(guardFrontmatter(raw)).toBe('oversize');
    },
  );

  it('measures the cap in bytes: a block under 64 Ki characters can still be over 64 KiB', () => {
    const raw = `---\nname: x\nk: ${WIDE_CHAR.repeat(WIDE_CHARS_OVER_BYTE_CAP)}\n---\nbody\n`;
    expect(raw.length).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);
    expect(guardFrontmatter(raw)).toBe('oversize');
  });

  it('lets a block of three-byte characters through while its bytes stay under the cap', () => {
    const raw = `---\nname: x\nk: ${WIDE_CHAR.repeat(WIDE_CHARS_UNDER_BYTE_CAP)}\n---\nbody\n`;
    expect(guardFrontmatter(raw)).toBeNull();
  });

  it('flags an unterminated block as oversize once it passes 64 KiB', () => {
    expect(guardFrontmatter(`---\nname: x\n${'z'.repeat(70 * KIB)}`)).toBe('oversize');
  });

  it('lets a block of exactly 64 KiB through', () => {
    const prefix = '\nname: x\nk: ';
    const raw = `---${prefix}${'v'.repeat(64 * KIB - prefix.length)}\n---\nbody\n`;
    expect(guardFrontmatter(raw)).toBeNull();
  });

  it('counts a white-space-only opener line toward the cap, as gray-matter slices it', () => {
    // A name that trims to nothing is left in the block, so `---` + U+00A0 adds one character.
    const prefix = '\nname: x\nk: ';
    const block = `${prefix}${'v'.repeat(64 * KIB - prefix.length)}`;
    expect(guardFrontmatter(`---${block}\n---\nbody\n`)).toBeNull();
    expect(guardFrontmatter(`---\u00A0${block}\n---\nbody\n`)).toBe('oversize');
  });

  it('leaves a small unterminated block to the YAML parser, as before', () => {
    expect(guardFrontmatter('---\nname: a\nbody with no closing fence')).toBeNull();
  });

  it.each([
    ['no frontmatter', 'just some text with &x and *y *z in it'],
    ['an ampersand inside a word', '---\ndescription: Q&A for **/*.md\n---\nbody'],
    ['a glob in a quoted tool name', '---\ntools: ["Bash(*)"]\n---\nbody'],
    ['an anchor with no alias', '---\nx: &a 1\ny: 2\n---\nbody'],
    ['one anchor reused once', SINGLE_ALIAS],
    ['aliases only in the body', '---\nname: a\n---\nbody &a [*a, *a]'],
    ['four dashes, which is not an opener', '----\na: &a [1]\nb: [*a, *a]\n---\nbody'],
    ['tool patterns with a colon before the star, which is not a flow key', COLON_STAR_TOOLS],
    ['a colon before the star inside a plain scalar', '---\na: &a 1\nb: x:*a y:*a\n---\nbody'],
  ])('does not flag %s', (_what, raw) => {
    expect(guardFrontmatter(raw)).toBeNull();
  });

  it('flags two aliases of one anchor, the smallest shape that can amplify', () => {
    expect(guardFrontmatter('---\na: &a [1, 2]\nb: [*a, *a]\n---\nbody')).toBe('aliases');
  });

  // Only aliases of a declared anchor count: js-yaml throws "unidentified alias" on any other.
  it.each([
    ['two aliases of a name no anchor declares', '---\na: &a [1]\nb: [*b, *b]\n---\nbody'],
    [
      'one alias of the anchor beside one of another name',
      '---\na: &a [1]\nb: [*a, *b]\n---\nbody',
    ],
    [
      'two alias-shaped globs and no anchor',
      '---\nname: l\ndescription: Lint *.ts and *.js files\n---\nbody',
    ],
    ['two aliases whose anchor is only in the body', '---\nname: a\nx: [*x, *y]\n---\nbody &x'],
  ])('does not flag %s', (_what, raw) => {
    expect(guardFrontmatter(raw)).toBeNull();
  });

  it.each(BENIGN_ALIAS_LOOKALIKES.map((skill) => [skill.name, skillWithTools(skill)] as const))(
    'keeps the whole frontmatter of %s, whose values only look like anchors and aliases',
    (_name, raw) => {
      expect(guardFrontmatter(raw)).toBeNull();

      const result = parseFrontmatter(raw);

      expect(result.recovery).toBeUndefined();
      expect(result.data['allowed-tools']).toEqual(['Bash', 'Read']);
      expect(result.data.model).toBe('sonnet');
      expect(result.data.triggers).toEqual(['lint', 'format']);
    },
  );

  it('reads a BOM and CRLF opener like gray-matter does', () => {
    expect(guardFrontmatter(`\uFEFF---\r\na: &a [1]\r\nb: [*a, *a]\r\n---\r\nbody`)).toBe(
      'aliases',
    );
  });
});

describe('guardFrontmatter line cap', () => {
  // Every line start a multiline `^` matches, so every shape gray-matter's comment strip pays for.
  it.each([
    ['LF', '\n', ONE_BYTE_RUN],
    ['bare CR', '\r', ONE_BYTE_RUN],
    ['space and LF', ' \n', TWO_BYTE_RUN],
    ['tab and LF', '\t\n', TWO_BYTE_RUN],
    ['CRLF', '\r\n', TWO_BYTE_RUN],
    ['U+2028', '\u2028', THREE_BYTE_RUN],
    ['U+2029', '\u2029', THREE_BYTE_RUN],
  ])(
    'skips a block of %s blank lines under the byte cap in bounded CPU time',
    (_what, unit, run) => {
      const raw = blankLineBlock(unit, run);
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);
      expect(guardFrontmatter(raw)).toBe('oversize');

      const { result, cpuMs } = cpuTimeMs(() => parseFrontmatter(raw));

      expect(result.recovery).toBe('line-based');
      expect(result.data).toEqual({ name: 'x' });
      expect(result.content).toBe('body');
      expect((result.recoveryCause as Error).message).toBe('frontmatter skipped: oversize');
      expect(cpuMs).toBeLessThan(CPU_BUDGET_MS);
    },
  );

  it('lets exactly the cap of line breaks through and refuses one more', () => {
    expect(guardFrontmatter(blankLineBlock('\n', MAX_FRONTMATTER_BLOCK_LINES))).toBeNull();
    expect(guardFrontmatter(blankLineBlock('\n', MAX_FRONTMATTER_BLOCK_LINES + 1))).toBe(
      'oversize',
    );
  });

  // A CRLF pair is one break for the cap. (As blank lines it costs the comment strip two line
  // starts per pair, which the strip budget below judges.)
  it('counts CRLF as one line break', () => {
    const lines = (breaks: number) => `---${'\r\nk: v'.repeat(breaks)}\n---\nbody`;
    expect(guardFrontmatter(lines(MAX_FRONTMATTER_BLOCK_LINES))).toBeNull();
    expect(guardFrontmatter(lines(MAX_FRONTMATTER_BLOCK_LINES + 1))).toBe('oversize');
  });
});

/**
 * The line cap bounds how many line starts the strip regex `/^\s*#[^\n]+/gm` visits, not what each
 * visit costs: at every line start `\s*` swallows the rest of the white-space run and backs off over
 * it when no `#` follows, so a run of line breaks and then a long run of spaces still costs
 * breaks x run. CRLF is the worst case, since `^` matches between CR and LF too.
 */
describe('guardFrontmatter comment-strip budget', () => {
  // A flow sequence may span lines with any white space, so the padded block is valid YAML.
  function paddedBlock(lineBreak: string, breaks: number, space: string, spaces: number): string {
    const padding = `${lineBreak.repeat(breaks)}${space.repeat(spaces)}`;
    return `---\nname: x\ntools: [a,${padding}b]\n---\nbody`;
  }

  it.each([
    ['LF and spaces', '\n', 1_990, ' ', 62_000],
    ['CRLF and spaces', '\r\n', 1_990, ' ', 61_000],
    ['LF and tabs', '\n', 1_990, '\t', 62_000],
    ['bare CR and spaces', '\r', 1_990, ' ', 62_000],
  ])(
    'skips a block of %s under the byte and line caps in bounded CPU time',
    (_what, lineBreak, breaks, space, spaces) => {
      const raw = paddedBlock(lineBreak, breaks, space, spaces);
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);

      const { result, cpuMs } = cpuTimeMs(() => parseFrontmatter(raw));

      expect(cpuMs).toBeLessThan(STRIP_CPU_BUDGET_MS);
      expect(guardFrontmatter(raw)).toBe('oversize');
      expect(result.recovery).toBe('line-based');
      expect(result.data).toEqual({ name: 'x' });
      expect(result.content).toBe('body');
    },
  );

  it('judges the work, not the shape: the same padding is let through while it stays cheap', () => {
    const breaks = 100;
    const cheapSpaces = Math.floor(MAX_COMMENT_STRIP_STEPS / (breaks + 1)) - breaks - 100;
    const dearSpaces = Math.floor(MAX_COMMENT_STRIP_STEPS / (breaks + 1)) - breaks + 100;
    expect(cheapSpaces + breaks).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);
    expect(dearSpaces + breaks).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);

    expect(guardFrontmatter(paddedBlock('\n', breaks, ' ', cheapSpaces))).toBeNull();
    expect(guardFrontmatter(paddedBlock('\n', breaks, ' ', dearSpaces))).toBe('oversize');
  });

  it('leaves ordinary frontmatter alone: indentation, blank lines and a long block scalar', () => {
    const indented = Array.from({ length: 300 }, (_, i) => `  - item ${i}`).join('\n');
    const scalar = `${'text\n'.repeat(200)}\n\n\n${'more\n'.repeat(200)}`;
    const raw = `---\nname: x\nlist:\n${indented}\nnotes: |\n${scalar.replace(/^/gm, '  ')}\n---\nbody`;

    expect(guardFrontmatter(raw)).toBeNull();
    expect(parseFrontmatter(raw).recovery).toBeUndefined();
  });
});

describe('parseFrontmatter on hostile YAML', () => {
  it.each([
    ['a plain opener', aliasBomb('allowed-tools')],
    ['a ---yaml opener', aliasBomb('allowed-tools', '---yaml')],
    ['a ---YAML opener', aliasBomb('allowed-tools', '---YAML')],
    ['a no-break-space opener', aliasBomb('allowed-tools', '---\u00A0yaml')],
    ['a bare-CR opener', aliasBomb('allowed-tools', '---\r\r')],
    ['flow mappings', flowMapBomb('allowed-tools')],
    ['flow mappings with a space before the colons', flowMapBomb('allowed-tools', ' :')],
    ['a verbatim tag before every anchor', aliasBomb('allowed-tools', '---', 8, VERBATIM_SEQ_TAG)],
  ])('skips the alias bomb behind %s with a cheap line-based recovery', (_what, raw) => {
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();

    const result = parseFrontmatter(raw);

    const elapsed = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    expect(result.recovery).toBe('line-based');
    expect(result.data).toEqual({ name: 'laughs', description: 'billion laughs' });
    expect(result.content).toBe('body');
    expect((result.recoveryCause as Error).message).toBe('frontmatter skipped: aliases');
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
    expect(heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
  });

  it('skips an oversize block the same way and keeps the body', () => {
    const raw = `---\nname: big\ndescription: d\nk: ${'v'.repeat(70 * KIB)}\n---\nbody\n`;

    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('line-based');
    expect(result.data).toEqual({ name: 'big', description: 'd' });
    expect(result.content).toBe('body');
    expect((result.recoveryCause as Error).message).toBe('frontmatter skipped: oversize');
  });

  it('indexes a guarded block with nothing recoverable as empty data and the body', () => {
    const raw = `---\nk: ${'v'.repeat(70 * KIB)}\n---\nbody text\n`;

    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('line-based');
    expect(result.data).toEqual({});
    expect(result.content).toBe('body text');
  });

  it('recovers a whole-file block of newlines from its first 64 KiB, not from every line', () => {
    const raw = `---\nname: huge\n${'\n'.repeat(WHOLE_FILE_BLOCK_CHARS)}`;
    const heapBefore = process.memoryUsage().heapUsed;

    const { result, cpuMs } = cpuTimeMs(() => parseFrontmatter(raw));

    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    expect(result.recovery).toBe('line-based');
    expect(result.data).toEqual({ name: 'huge' });
    expect(result.content).toBe('');
    expect((result.recoveryCause as Error).message).toBe('frontmatter skipped: oversize');
    expect(heapDelta).toBeLessThan(OVERSIZE_HEAP_BUDGET_BYTES);
    expect(cpuMs).toBeLessThan(OVERSIZE_CPU_BUDGET_MS);
  });

  // The guard finds the closer by its dashes, so these pin where a `---` is and is not the closer:
  // gray-matter takes the first newline followed by three dashes, whatever follows them.
  it.each([
    [
      'dashes inside a value',
      `---\nname: x\nk: ---${'v'.repeat(70 * KIB)}\nz: a---b\n---\nbody\n`,
      'oversize',
    ],
    [
      'a line of four dashes before the closer',
      `---\nname: x\nk: ${'v'.repeat(70 * KIB)}\n----\nbody\n`,
      'oversize',
    ],
    [
      'a run of dashes with no newline after it',
      `---\nname: x\nk: ${'v'.repeat(70 * KIB)}\n${'-'.repeat(50)}`,
      'oversize',
    ],
    [
      'dashes right after the opener line, which close an empty block',
      `---\n---x\nname: x\nk: ${'v'.repeat(70 * KIB)}\n---\nbody\n`,
      null,
    ],
  ])('splits a block with %s where gray-matter does', (_what, raw, reason) => {
    expect(guardFrontmatter(raw)).toBe(reason);
    expect(parseFrontmatter(raw).content).toBe(matter(raw, {}).content.trim());
  });

  it('still parses one anchor reused once exactly as before', () => {
    const result = parseFrontmatter(SINGLE_ALIAS);

    expect(result.recovery).toBe('quoted');
    expect(result.data.copy).toBe('shared');
  });
});

describe('parsers with hostile YAML', () => {
  let tempDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fm-guard-'));
    skillsDir = join(tempDir, 'skills');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes a circular allowed-tools skill with serialisable metadata and one warning', async () => {
    await mkdir(join(skillsDir, 'circ'), { recursive: true });
    await writeFile(
      join(skillsDir, 'circ', 'SKILL.md'),
      '---\nname: circ\ndescription: circular\nallowed-tools: &a [*a]\n---\nBody\n',
    );

    const result = await parseSkills(skillsDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('circ');
    expect(() => JSON.stringify(result.entries[0].metadata)).not.toThrow();
    expect(result.errors).toHaveLength(1);
    expect(getParseSeverity(result.errors[0])).toBe('warning');
  });

  it('indexes the benign look-alikes with their tools and triggers and no warning', async () => {
    for (const skill of BENIGN_ALIAS_LOOKALIKES) {
      await mkdir(join(skillsDir, skill.name), { recursive: true });
      await writeFile(join(skillsDir, skill.name, 'SKILL.md'), skillWithTools(skill));
    }

    const result = await parseSkills(skillsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => e.name).sort()).toEqual(
      BENIGN_ALIAS_LOOKALIKES.map((skill) => skill.name).sort(),
    );
    for (const entry of result.entries) {
      expect(entry.metadata.allowedTools).toEqual(['Bash', 'Read']);
      expect(entry.metadata.triggers).toEqual(['lint', 'format']);
      expect(entry.metadata.frontmatterRecovery).toBeUndefined();
      expect(entry.tags).not.toContain(FRONTMATTER_WARNING_TAG);
    }
  });

  it('indexes the alias bomb under its name with one line-based recovery warning', async () => {
    await mkdir(join(skillsDir, 'laughs'), { recursive: true });
    await writeFile(join(skillsDir, 'laughs', 'SKILL.md'), aliasBomb('allowed-tools'));

    const result = await parseSkills(skillsDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('laughs');
    expect(result.entries[0].metadata.frontmatterRecovery).toBe('line-based');
    expect(result.entries[0].metadata.allowedTools).toBeUndefined();
    expect(JSON.stringify(result.entries[0].metadata).length).toBeLessThan(KIB);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/frontmatter skipped: aliases/);
    expect(getParseSeverity(result.errors[0])).toBe('warning');
  });
});
