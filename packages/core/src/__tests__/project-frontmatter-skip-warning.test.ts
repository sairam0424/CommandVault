import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';
import { aliasBomb } from './hostile-claude-dir.js';

/**
 * A Claude-directory skill whose frontmatter the guard skips is indexed under its name with a
 * warning. The agent-config files of a `--project` scan (CLAUDE.md, Cursor rules, the project's
 * `.claude/*.md`) are read by another parser and used to skip silently: the entry was indexed with
 * its name and description and no problem recorded. They now warn the same way, for a skip only;
 * an ordinary YAML recovery stays silent in these files, as before.
 */

const KIB = 1024;
const OVERSIZE_CHARS = 70 * KIB;
const SKIP_PATTERN = /frontmatter skipped: (aliases|oversize)/;

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'cv-project-skip-')));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function writeProjectFile(relative: string, text: string): Promise<string> {
  const path = join(projectRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe('a project file whose frontmatter the guard skips', () => {
  it.each([
    ['CLAUDE.md', 'CLAUDE.md'],
    ['.cursor/rules/bomb.mdc', '.cursor/rules/bomb.mdc'],
    ['.claude/bomb.md', '.claude/bomb.md'],
    ['.github/copilot-instructions.md', '.github/copilot-instructions.md'],
    ['.windsurf/rules/bomb.md', '.windsurf/rules/bomb.md'],
  ])('warns once for an alias bomb in %s and still indexes the file', async (_label, relative) => {
    const path = await writeProjectFile(relative, aliasBomb('allowed-tools'));

    const result = await detectAgentConfigs(projectRoot);

    const warnings = result.errors.filter((error) => error.filePath === path);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/frontmatter skipped: aliases/);
    expect(getParseSeverity(warnings[0])).toBe('warning');
    expect(result.entries.filter((entry) => entry.filePath === path)).toHaveLength(1);
  });

  it('warns for a bomb whose anchor hides behind a look-alike token in a quoted key', async () => {
    const hidden = [
      '---',
      'name: hidden',
      `m: {" &z" :&s "${'x'.repeat(200)}"}`,
      `r: [${Array<string>(40).fill('*s').join(', ')}]`,
      '---',
      'body',
      '',
    ].join('\n');
    const path = await writeProjectFile('CLAUDE.md', hidden);

    const result = await detectAgentConfigs(projectRoot);

    const warnings = result.errors.filter((error) => error.filePath === path);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(SKIP_PATTERN);
    expect(JSON.stringify(result.entries)).not.toContain('xxxxxxxxxxxxxxxx');
  });

  it('warns for frontmatter over the size cap in a Cursor rule file', async () => {
    const path = await writeProjectFile(
      '.cursorrules',
      `---\nname: big\nk: ${'v'.repeat(OVERSIZE_CHARS)}\n---\nbody\n`,
    );

    const result = await detectAgentConfigs(projectRoot);

    const warnings = result.errors.filter((error) => error.filePath === path);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/frontmatter skipped: oversize/);
  });

  it('keeps ordinary files silent: sound YAML, and invalid YAML that is only recovered', async () => {
    const sound = await writeProjectFile('CLAUDE.md', '---\nname: ok\n---\nbody\n');
    const recovered = await writeProjectFile(
      '.claude/hint.md',
      '---\nname: hint\ndescription: has a hint\nargument-hint: [a] [b]\n---\nbody\n',
    );

    const result = await detectAgentConfigs(projectRoot);

    expect(result.errors.filter((e) => [sound, recovered].includes(e.filePath))).toEqual([]);
    expect(result.entries.filter((e) => [sound, recovered].includes(e.filePath))).toHaveLength(2);
  });
});
