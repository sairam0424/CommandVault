import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  context,
  createSandbox,
  IS_WINDOWS,
  parseJson,
  type RunResult,
  type Sandbox,
} from './harness.js';

/**
 * Against the BUILT binary: a skill whose frontmatter, a directory whose name and a bundle whose
 * records carry terminal escape sequences. Nothing printed may hold one of them, the entry must
 * still be shown, and `--json` must keep the data as it is.
 */

vi.setConfig({ testTimeout: 60_000 });

const ESC = '\u001b';
const BEL = '\u0007';
const OSC_TITLE = `${ESC}]0;PWNED-TITLE${BEL}`;
const HYPERLINK = `${ESC}]8;;https://evil.example/${BEL}LINK${ESC}]8;;${BEL}`;
const CLIPBOARD = `${ESC}]52;c;UFdORUQ=${BEL}`;
const EIGHT_BIT_OSC = '\u009d0;C1TITLE\u009c';
const NAME_PAYLOAD = `${OSC_TITLE}${ESC}[2J${HYPERLINK}${CLIPBOARD}${EIGHT_BIT_OSC}\u202eBIDI`;
const DESCRIPTION_PAYLOAD = `desc ${ESC}[31mRED${ESC}[0m \u009b2J\u0090dcs\u009c`;
const TAG_PAYLOAD = `t${ESC}]0;TAG${BEL}`;
const HOSTILE_DIR = `esc${ESC}]0;X${BEL}-dir`;

/** Code points no output may hold: ESC, 8-bit CSI/OSC/DCS/ST, BEL, line separator, RTL override. */
const BAD_CODE_POINTS: ReadonlySet<number> = new Set([
  0x1b, 0x9b, 0x9d, 0x90, 0x9c, 0x07, 0x2028, 0x202e,
]);

/** A YAML double-quoted scalar; js-yaml reads \xHH and \uHHHH, so no raw control byte is written. */
function yamlQuote(text: string): string {
  const escaped = [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (ch === '\\' || ch === '"') return `\\${ch}`;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        return `\\x${code.toString(16).padStart(2, '0')}`;
      }
      if (code === 0x2028 || code === 0x202e) return `\\u${code.toString(16)}`;
      return ch;
    })
    .join('');
  return `"${escaped}"`;
}

function skillFile(name: string, description: string, tags: readonly string[]): string {
  const tagList = tags.map(yamlQuote).join(', ');
  return `---\nname: ${yamlQuote(name)}\ndescription: ${yamlQuote(description)}\ntags: [${tagList}]\n---\nbody\n`;
}

interface HostileFixture {
  readonly box: Sandbox;
  readonly hostileSkillDir: string;
  readonly bundle: string;
}

function writeHostileFixture(): HostileFixture {
  const box = createSandbox();
  const skills = join(box.home, '.claude', 'skills');
  const hostileSkillDir = join(skills, 'hostile-skill');
  mkdirSync(hostileSkillDir, { recursive: true });
  writeFileSync(
    join(hostileSkillDir, 'SKILL.md'),
    skillFile(`hostile-skill${NAME_PAYLOAD}`, DESCRIPTION_PAYLOAD, [TAG_PAYLOAD]),
  );
  if (!IS_WINDOWS) {
    const pathySkillDir = join(skills, HOSTILE_DIR);
    mkdirSync(pathySkillDir, { recursive: true });
    writeFileSync(join(pathySkillDir, 'SKILL.md'), skillFile('pathy-skill', 'plain', []));
  }
  const bundle = join(box.workDir, 'hostile.vault.json');
  writeFileSync(
    bundle,
    JSON.stringify({
      version: '1',
      source: 'e2e',
      entries: [
        { name: `bundle${OSC_TITLE}${EIGHT_BIT_OSC}`, type: 'skill', description: `d${ESC}[2J` },
      ],
    }),
  );
  return { box, hostileSkillDir, bundle };
}

function badCodePoints(text: string): string[] {
  return [...text]
    .filter((ch) => BAD_CODE_POINTS.has(ch.codePointAt(0) ?? 0))
    .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
}

/**
 * Decoded stdout and stderr hold no control code point and neither payload body ('PWNED' rides
 * the 7-bit OSC, 'C1TITLE' the 8-bit one: a body left behind means the introducer was deleted
 * as a lone character instead of the sequence being removed whole); the entry is shown.
 */
function expectClean(result: RunResult, stem: string): void {
  const all = `${result.stdout}\n${result.stderr}`;
  expect(badCodePoints(all), context(result)).toEqual([]);
  expect(all, context(result)).not.toContain('PWNED');
  expect(all, context(result)).not.toContain('C1TITLE');
  expect(result.stdout, context(result)).toContain(stem);
}

const fixtures: HostileFixture[] = [];

function hostile(): HostileFixture {
  const fixture = writeHostileFixture();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const { box } of fixtures.splice(0)) box.dispose();
});

describe('built CLI: hostile entry fields never reach the terminal', () => {
  it.each([
    ['list', ['list'], 'hostile-skill'],
    ['list --type skill', ['list', '--type', 'skill'], 'hostile-skill'],
    ['search', ['search', 'hostile'], 'hostile-skill'],
    ['info', ['info', 'hostile-skill'], 'hostile-skill'],
    ['run', ['run', 'hostile-skill'], 'hostile-skill'],
    ['tag list', ['tag', 'list', 'hostile-skill'], 'hostile-skill'],
    ['audit', ['audit'], 'hostile-skill'],
    ['favorite', ['favorite', 'hostile-skill'], 'hostile-skill'],
  ])('%s', (_name, args, stem) => {
    const { box } = hostile();
    const result = box.run(args);
    expect(result.status, context(result)).toBe(0);
    expectClean(result, stem);
  });

  it('import --dry-run of a hostile bundle', () => {
    const { box, bundle } = hostile();
    const result = box.run(['import', '--dry-run', bundle]);
    expect(result.status, context(result)).toBe(0);
    expectClean(result, 'bundle');
  });

  it('diff prints the removed entry by its name', () => {
    const { box, hostileSkillDir } = hostile();
    const baseline = box.run(['diff']);
    expect(baseline.status, context(baseline)).toBe(0);
    rmSync(hostileSkillDir, { recursive: true, force: true });
    const result = box.run(['diff']);
    expect(result.status, context(result)).toBe(0);
    expectClean(result, 'hostile-skill');
    expect(result.stdout, context(result)).toMatch(/- hostile-skill/);
  });

  it('open names the entry on stdout and fails cleanly when the editor is missing', () => {
    const { box } = hostile();
    const result = box.run(['open', 'hostile-skill'], {
      EDITOR: join(box.workDir, 'no-such-editor'),
    });
    expect(result.status, context(result)).not.toBe(0);
    expectClean(result, 'hostile-skill');
  });

  it.skipIf(IS_WINDOWS)('a hostile directory name shows up as a clean file path', () => {
    const { box } = hostile();
    const result = box.run(['info', 'pathy-skill']);
    expect(result.status, context(result)).toBe(0);
    expectClean(result, 'pathy-skill');
    expect(result.stdout, context(result)).toContain('-dir');
  });
});

describe('built CLI: --json keeps the data and escapes what a terminal would obey', () => {
  it.each([
    ['list', ['list', '--json'], (data: { entries: { name: string }[] }) => data.entries],
    [
      'search',
      ['search', 'hostile', '--json'],
      (data: { results: { entry: { name: string } }[] }) => data.results.map((r) => r.entry),
    ],
    [
      'info',
      ['info', 'hostile-skill', '--json'],
      (data: { entry: { name: string } }) => [data.entry],
    ],
    ['run', ['run', 'hostile-skill', '--json'], (data: { name: string }) => [data]],
  ])('%s', (_name, args, entriesOf) => {
    const { box } = hostile();
    const result = box.run(args);
    expect(result.status, context(result)).toBe(0);
    const names = entriesOf(parseJson(result) as never).map((entry) => entry.name);
    expect(names.some((name) => name.includes(ESC) && name.includes('\u009d'))).toBe(true);
    expect(badCodePoints(result.stdout), context(result)).toEqual([]);
  });
});

describe('built CLI: colour follows the stream and the environment', () => {
  it('writes no escape at all into a pipe without CI or NO_COLOR', () => {
    const { box } = hostile();
    const result = box.run(['list'], {
      CI: undefined,
      NO_COLOR: undefined,
      TERM: 'xterm-256color',
    });
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout, context(result)).toContain('hostile-skill');
    expect(result.stdout, context(result)).not.toContain(ESC);
  });

  it('colours when FORCE_COLOR asks for it, so the test can tell the two apart', () => {
    const { box } = hostile();
    const result = box.run(['list'], {
      CI: undefined,
      NO_COLOR: undefined,
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
    });
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout, context(result)).toContain(ESC);
  });
});
