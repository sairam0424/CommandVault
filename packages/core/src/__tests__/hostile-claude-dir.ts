import { execFileSync } from 'node:child_process';
import { chmod, mkdir, open, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PARSE_FILE_BYTES } from '../constants.js';
import { SYNTHETIC_ENTRY_COUNT, buildSyntheticClaudeDir } from './synthetic-claude-dir.js';

/**
 * A Claude configuration directory and a project directory holding every hostile file shape the
 * parsers must survive (nothing hangs, nothing amplifies, nothing outside the project is read),
 * next to the benign shapes that must keep indexing exactly as before. `expectedCounts()` is the
 * contract: how many entries and how many warnings a full scan of both must produce.
 *
 * Also a script, for the acceptance run through the built CLI:
 *   node packages/core/dist/__tests__/hostile-claude-dir.js <claudeDir> <projectDir>
 * Each directory's outside targets live in a sibling directory named `<dir>-outside`.
 */

export const OUTSIDE_MARKER = 'OUTSIDEMARKER-7f3c1e-must-never-be-indexed';

const KIB = 1024;
const GIB = 1024 * 1024 * 1024;
const BOMB_LEVELS = 8;
const BOMB_FAN_OUT = 9;
const DEEP_FLOW_DEPTH = 20_000;
const BIG_FRONTMATTER_CHARS = 70 * KIB;
// Enough keys to overrun the node budget while the block stays under the 64 KiB frontmatter cap
// (10 000 three-letter keys would be 70 KiB and hit the oversize guard first).
const MANY_KEYS = 7000;
// Under the 64 KiB block cap and far over the line cap: gray-matter's comment strip is quadratic in
// a run of blank lines, so without the cap this one block costs seconds of CPU.
const BLANK_LINES = 65_400;
// The line cap does not bound that strip by itself: a run of line breaks followed by a long run of
// spaces costs the strip every break times the whole run, and the block is still under the cap.
const PADDING_BREAKS = 1_990;
const PADDING_SPACES = 61_000;
// A whole 32 MiB file of frontmatter that never closes: the oversize recovery must not split all
// of it into lines.
const HUGE_BLANK_HEADER = '---\nname: huge-blank\n';
const NO_ACCESS = 0o000;
const FULL_ACCESS = 0o700;
const MARKER_FILE = '.hostile-corpus';

const IS_WINDOWS = process.platform === 'win32';
const IS_ROOT = process.getuid?.() === 0;

export interface CorpusCounts {
  readonly entries: number;
  readonly warnings: number;
}

interface CorpusItem {
  readonly name: string;
  readonly entries: number;
  readonly warnings: number;
  readonly enabled: boolean;
  readonly build: (root: string, outside: string) => Promise<void>;
}

/**
 * A verbatim tag, which js-yaml lets run straight into the anchor that follows it: no separating
 * space between `>` and `&`.
 */
export const VERBATIM_SEQ_TAG = '!<tag:yaml.org,2002:seq>';

/**
 * The classic nested-alias ("billion laughs") shape: 9^levels logical elements in under 500 bytes.
 * `anchorTag` is written right before every anchor.
 */
export function aliasBomb(
  key: string,
  opener = '---',
  levels = BOMB_LEVELS,
  anchorTag = '',
): string {
  const lines = [`a: ${anchorTag}&a0 [${Array<string>(BOMB_FAN_OUT).fill('"lol"').join(',')}]`];
  for (let i = 1; i < levels; i += 1) {
    lines.push(
      `a${i}: ${anchorTag}&a${i} [${Array<string>(BOMB_FAN_OUT)
        .fill(`*a${i - 1}`)
        .join(',')}]`,
    );
  }
  const alias = `${key}: *a${levels - 1}`;
  return `${opener}\nname: laughs\ndescription: billion laughs\n${lines.join('\n')}\n${alias}\n---\nbody\n`;
}

/**
 * The same DAG as flow mappings whose quoted keys touch their values (`"p0":*a0`), the one place
 * js-yaml takes an anchor or alias with no separating space before it. `sep` sits between the
 * quoted key and the colon: `:` touching the key, or separation space first (` :`, `\t:`), which
 * js-yaml skips after a JSON-like key before it looks for the colon.
 */
export function flowMapBomb(key: string, sep = ':', levels = BOMB_LEVELS): string {
  const leaf = `{"k0"${sep}&a0 [${Array<string>(BOMB_FAN_OUT).fill('"lol"').join(',')}]}`;
  const upper = Array.from({ length: levels - 1 }, (_, index) => {
    const level = index + 1;
    const refs = Array.from({ length: BOMB_FAN_OUT }, (_, j) => `"p${j}"${sep}*a${level - 1}`);
    return `{"k${level}"${sep}&a${level} {${refs.join(',')}}}`;
  });
  const bomb = `bomb: [${[leaf, ...upper].join(',')}]`;
  const alias = `${key}: *a${levels - 1}`;
  return `---\nname: laughs\ndescription: billion laughs\n${bomb}\n${alias}\n---\nbody\n`;
}

/** `count` distinct three-letter keys in flow style (7 bytes each), far over the node budget. */
export function manyKeys(name: string, count = MANY_KEYS): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const keys: string[] = [];
  for (let i = 0; keys.length < count; i += 1) {
    const key = letters[Math.floor(i / 676)] + letters[Math.floor(i / 26) % 26] + letters[i % 26];
    keys.push(`${key}: 1`);
  }
  return `---\n{name: ${name},${keys.join(',')}}\n---\nBody\n`;
}

function markdown(
  name: string,
  description = `Describes ${name}`,
  body = `Body of ${name}.`,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

async function writeIn(root: string, relative: string, text: string | Buffer): Promise<string> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function linkIn(root: string, relative: string, target: string, type?: 'dir'): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, type);
}

function fifoIn(root: string, relative: string): Promise<void> {
  return mkdir(join(root, dirname(relative)), { recursive: true }).then(() => {
    execFileSync('mkfifo', [join(root, relative)]);
  });
}

/**
 * Binds a Unix socket from a child process that changes into the directory first, so the name
 * handed to the kernel is the short basename (sun_path is 104 bytes on macOS). The file outlives
 * the child: a socket nobody listens on still cannot be opened as a file.
 */
const BIND_SOCKET_SCRIPT =
  'process.chdir(process.argv[1]);' +
  'require("node:net").createServer().listen(process.argv[2], () => process.exit(0));';

async function socketIn(root: string, relative: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  execFileSync(process.execPath, ['-e', BIND_SOCKET_SCRIPT, dirname(path), basename(path)]);
}

async function sparseIn(root: string, relative: string, size: number): Promise<void> {
  const path = await writeIn(root, relative, '');
  const handle = await open(path, 'r+');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

interface SkillShape {
  readonly name: string;
  readonly description: string;
  /** A line placed before `description`, for a YAML comment. */
  readonly leadingLine?: string;
}

/**
 * Valid YAML whose values only look like anchors and aliases (`&&`, `*.ts`, `*regex*`, a comment
 * naming an anchor). Each must keep its whole frontmatter: allowed-tools, model and triggers.
 */
export const BENIGN_ALIAS_LOOKALIKES: readonly SkillShape[] = [
  { name: 'lint-globs', description: 'Runs lint && test on *.ts and *.js files' },
  { name: 'search-replace', description: 'Search & replace with *regex* or *literal*' },
  { name: 'format-globs', description: 'Formats *.ts, *.js & *.md files' },
  {
    name: 'anchor-comment',
    description: 'Commented',
    leadingLine: '# anchors: declare &base once, then reuse it with *base or *other',
  },
  { name: 'lint-two-globs', description: 'Lint *.ts and *.js files' },
];

export function skillWithTools(skill: SkillShape): string {
  const lines = [
    `name: ${skill.name}`,
    ...(skill.leadingLine === undefined ? [] : [skill.leadingLine]),
    `description: ${skill.description}`,
    'allowed-tools: [Bash, Read]',
    'model: sonnet',
    'triggers: [lint, format]',
  ];
  return `---\n${lines.join('\n')}\n---\nBody of ${skill.name}.\n`;
}

const HOSTILE_CLAUDE_ITEMS: readonly CorpusItem[] = [
  {
    name: 'fifo',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: (r) => fifoIn(r, 'commands/pipe.md'),
  },
  {
    name: 'character device',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: (r) => linkIn(r, 'agents/zero.md', '/dev/zero'),
  },
  {
    name: 'symlink loop',
    entries: 0,
    warnings: 2,
    enabled: true,
    build: async (r) => {
      await linkIn(r, 'agents/loop-a.md', 'loop-b.md');
      await linkIn(r, 'agents/loop-b.md', 'loop-a.md');
    },
  },
  {
    name: 'socket',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: (r) => socketIn(r, 'commands/sock.md'),
  },
  {
    name: 'directory named .md',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      await mkdir(join(r, 'agents', 'folder.md'), { recursive: true });
    },
  },
  {
    name: '1 GiB sparse file',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: (r) => sparseIn(r, 'commands/sparse.md', GIB),
  },
  {
    name: 'alias bomb',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      await writeIn(r, 'skills/laughs/SKILL.md', aliasBomb('allowed-tools'));
    },
  },
  {
    name: 'circular anchor',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      await writeIn(
        r,
        'skills/circ/SKILL.md',
        '---\nname: circ\ndescription: circular\nallowed-tools: &a [*a]\n---\nBody\n',
      );
    },
  },
  {
    name: '70 KiB frontmatter',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const block = `name: big-frontmatter\ndescription: big\nk: ${'v'.repeat(BIG_FRONTMATTER_CHARS)}`;
      await writeIn(r, 'skills/big-frontmatter/SKILL.md', `---\n${block}\n---\nBody\n`);
    },
  },
  {
    name: '---yaml alias bomb',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const bomb = aliasBomb('triggers', '---yaml').replace('name: laughs', 'name: laughs-yaml');
      await writeIn(r, 'skills/laughs-yaml/SKILL.md', bomb);
    },
  },
  {
    name: '---YAML alias bomb (gray-matter lowercases the engine name)',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const bomb = aliasBomb('triggers', '---YAML').replace('name: laughs', 'name: laughs-upper');
      await writeIn(r, 'skills/laughs-upper/SKILL.md', bomb);
    },
  },
  {
    name: 'alias bomb behind an opener padded with a no-break space (gray-matter trims it)',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const bomb = aliasBomb('triggers', '---\u00A0yaml');
      await writeIn(
        r,
        'skills/laughs-nbsp/SKILL.md',
        bomb.replace('name: laughs', 'name: laughs-nbsp'),
      );
    },
  },
  {
    name: 'alias bomb as flow mappings with no space after the quoted keys',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const bomb = flowMapBomb('triggers').replace('name: laughs', 'name: laughs-flow');
      await writeIn(r, 'skills/laughs-flow/SKILL.md', bomb);
    },
  },
  {
    name: 'alias bomb as flow mappings with separation space before the colons',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const bomb = flowMapBomb('triggers', ' :').replace(
        'name: laughs',
        'name: laughs-flow-spaced',
      );
      await writeIn(r, 'skills/laughs-flow-spaced/SKILL.md', bomb);
    },
  },
  {
    name: 'blank-line frontmatter under the byte cap (quadratic comment strip in gray-matter)',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const block = `name: blank-lines\ndescription: blank${'\n'.repeat(BLANK_LINES)}`;
      await writeIn(r, 'skills/blank-lines/SKILL.md', `---\n${block}---\nBody\n`);
    },
  },
  {
    name: 'alias bomb with a verbatim tag right before every anchor',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const bomb = aliasBomb('triggers', '---', BOMB_LEVELS, VERBATIM_SEQ_TAG);
      await writeIn(r, 'skills/laughs-tagged/SKILL.md', bomb.replace('laughs', 'laughs-tagged'));
    },
  },
  {
    name: 'CRLF breaks and a long run of spaces under the line cap (comment strip in gray-matter)',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const padding = `${'\r\n'.repeat(PADDING_BREAKS)}${' '.repeat(PADDING_SPACES)}`;
      const block = `name: padded\ntools: [a,${padding}b]`;
      await writeIn(r, 'skills/padded/SKILL.md', `---\n${block}\n---\nBody\n`);
    },
  },
  {
    name: '32 MiB newline-only frontmatter with no closer',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      const newlines = '\n'.repeat(MAX_PARSE_FILE_BYTES - HUGE_BLANK_HEADER.length);
      await writeIn(r, 'commands/huge-blank.md', `${HUGE_BLANK_HEADER}${newlines}`);
    },
  },
  {
    name: 'deep flow sequence',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      const flow = '['.repeat(DEEP_FLOW_DEPTH) + ']'.repeat(DEEP_FLOW_DEPTH);
      await writeIn(
        r,
        'commands/deep.md',
        `---\nname: deep\ndescription: deep\nx: ${flow}\n---\nBody\n`,
      );
    },
  },
  {
    name: 'thousands of keys',
    entries: 1,
    warnings: 1,
    enabled: true,
    build: async (r) => {
      await writeIn(r, 'agents/keys.md', manyKeys('keys'));
    },
  },
  {
    name: 'invalid UTF-8',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      const bytes = Buffer.concat([Buffer.from('# Bad bytes\n'), Buffer.from([0xff, 0xfe, 0xc3])]);
      await writeIn(r, 'rules/bad-utf8.md', bytes);
    },
  },
  {
    name: 'BOM and CRLF frontmatter',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      const text =
        '\uFEFF---\r\nname: bom-crlf\r\ndescription: BOM and CRLF\r\n---\r\n# Heading\r\nBody\r\n';
      await writeIn(r, 'rules/bom-crlf.md', text);
    },
  },
  {
    name: 'unreadable subdirectory',
    entries: 0,
    warnings: 1,
    enabled: !IS_ROOT,
    build: async (r) => {
      await writeIn(r, 'commands/locked/hidden.md', markdown('hidden'));
      await chmod(join(r, 'commands', 'locked'), NO_ACCESS);
    },
  },
];

const BENIGN_CLAUDE_ITEMS: readonly CorpusItem[] = [
  {
    name: 'synthetic directory',
    entries: SYNTHETIC_ENTRY_COUNT,
    warnings: 0,
    enabled: true,
    build: (r) => buildSyntheticClaudeDir(r),
  },
  {
    name: 'empty plugin registry',
    entries: 0,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      await writeIn(
        r,
        'plugins/installed_plugins.json',
        JSON.stringify({ version: 2, plugins: {} }),
      );
    },
  },
  {
    name: 'file link inside the directory',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      await writeIn(r, 'extra/inside-agent.md', markdown('inside-agent'));
      await linkIn(r, 'agents/linked-inside.md', join('..', 'extra', 'inside-agent.md'));
    },
  },
  {
    name: 'file link outside the directory',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r, outside) => {
      const target = await writeIn(outside, 'outside-rule.md', markdown('outside-rule'));
      await linkIn(r, 'rules/linked-outside.md', target);
    },
  },
  {
    name: 'linked skill directory',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r, outside) => {
      await writeIn(outside, 'linked-skill/SKILL.md', markdown('linked-skill'));
      await linkIn(r, 'skills/linked-skill', join(outside, 'linked-skill'), 'dir');
    },
  },
  {
    name: 'ampersand and glob in values',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      const text =
        '---\nname: qa\ndescription: Q&A for **/*.md\nallowed-tools: ["Bash(*)"]\n---\nBody\n';
      await writeIn(r, 'commands/qa.md', text);
    },
  },
  {
    name: 'anchor without alias',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      await writeIn(
        r,
        'commands/anchor.md',
        '---\nname: anchor\ndescription: a\nx: &a 1\n---\nBody\n',
      );
    },
  },
  ...BENIGN_ALIAS_LOOKALIKES.map((skill): CorpusItem => ({
    name: `benign alias look-alike: ${skill.name}`,
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      await writeIn(r, `skills/${skill.name}/SKILL.md`, skillWithTools(skill));
    },
  })),
];

const PROJECT_ITEMS: readonly CorpusItem[] = [
  {
    name: 'CLAUDE.md linking outside the project',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: async (r, outside) => {
      const target = await writeIn(outside, 'secret.md', `# Secret\n${OUTSIDE_MARKER}\n`);
      await linkIn(r, 'CLAUDE.md', target);
    },
  },
  {
    name: 'cursor rule linking outside the project',
    entries: 0,
    warnings: 1,
    enabled: true,
    build: async (r, outside) => {
      const target = await writeIn(outside, 'secret-rule.md', `# Secret rule\n${OUTSIDE_MARKER}\n`);
      await linkIn(r, '.cursor/rules/x.mdc', target);
    },
  },
  {
    name: 'plain cursorrules',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      await writeIn(r, '.cursorrules', '# Cursor Rules\nBe nice.\n');
    },
  },
  {
    name: 'claude rule linking inside the project',
    entries: 1,
    warnings: 0,
    enabled: true,
    build: async (r) => {
      const target = await writeIn(r, 'docs/guide.md', markdown('guide'));
      await linkIn(r, '.claude/y.md', target);
    },
  },
];

const ALL_ITEMS = [...HOSTILE_CLAUDE_ITEMS, ...BENIGN_CLAUDE_ITEMS, ...PROJECT_ITEMS];

function sum(items: readonly CorpusItem[], field: 'entries' | 'warnings'): number {
  return items.filter((item) => item.enabled).reduce((total, item) => total + item[field], 0);
}

/** Entries and warnings a scan of both directories must produce; the hostile, indexed-anyway shapes count as entries too. */
export function expectedCounts(): CorpusCounts {
  return { entries: sum(ALL_ITEMS, 'entries'), warnings: sum(ALL_ITEMS, 'warnings') };
}

/** Where a directory's outside-of-scope targets are written. */
export function outsideDirFor(root: string): string {
  return `${root}-outside`;
}

async function buildItems(items: readonly CorpusItem[], root: string): Promise<void> {
  const outside = outsideDirFor(root);
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, MARKER_FILE), 'built by hostile-claude-dir.ts\n');
  for (const item of items.filter((i) => i.enabled)) await item.build(root, outside);
}

export async function buildHostileClaudeDir(root: string): Promise<void> {
  if (IS_WINDOWS)
    throw new Error('the hostile corpus needs FIFOs, sockets and symlinks: posix only');
  await buildItems([...BENIGN_CLAUDE_ITEMS, ...HOSTILE_CLAUDE_ITEMS], root);
}

export async function buildHostileProject(root: string): Promise<void> {
  await buildItems(PROJECT_ITEMS, root);
}

/** Removes a corpus this module built (and nothing else): the locked directory must be reopened first. */
export async function removeHostileDir(root: string): Promise<void> {
  const marked = await stat(join(root, MARKER_FILE)).then(
    () => true,
    () => false,
  );
  if (!marked) throw new Error(`${root} was not built by hostile-claude-dir.ts; not removing it`);
  await chmod(join(root, 'commands', 'locked'), FULL_ACCESS).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  await rm(outsideDirFor(root), { recursive: true, force: true });
}

async function main(claudeDir: string, projectDir: string): Promise<void> {
  for (const dir of [claudeDir, projectDir]) {
    const exists = await stat(dir).then(
      () => true,
      () => false,
    );
    if (exists) await removeHostileDir(dir);
  }
  await buildHostileClaudeDir(claudeDir);
  await buildHostileProject(projectDir);
  console.log(
    JSON.stringify({ claudeDir, projectDir, outsideMarker: OUTSIDE_MARKER, ...expectedCounts() }),
  );
}

const isScript =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isScript) {
  const [claudeDir, projectDir] = process.argv.slice(2);
  if (!claudeDir || !projectDir) {
    console.error('usage: hostile-claude-dir.js <claudeDir> <projectDir>');
    process.exit(64);
  }
  main(claudeDir, projectDir).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
