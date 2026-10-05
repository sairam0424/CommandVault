import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter } from '../parsers/utils.js';
import { parseAgents } from '../parsers/agent-parser.js';
import { parseCommands } from '../parsers/command-parser.js';
import { parseSkills } from '../parsers/skill-parser.js';

// Synthetic shapes modelled on the two real failure classes: a flow-sequence-looking
// value that is not a sequence, and a generated `hooks:` block whose body continues
// at column 0. No personal content and nothing from the real HOME.
const COMMAND_WITH_FLOW_LOOKING_VALUES = `---
description: Plan a phase. Usage: run [N] times
argument-hint: [a] [b]
allowed-tools: Read, Bash
---

# Plan

Body text.
`;

const AGENT_WITH_COLUMN_ZERO_HOOKS = `---
name: "synthetic-reviewer"
description: "Reviews synthetic diffs for the recovery tests"
tools: Read, Write
model: opus
hooks:
  pre: |
    echo "activated: $TASK"
run-the-scan --target="$TASK"
  post: |
    echo "done"
---
You are a synthetic reviewer.

## Guidelines
- Be careful
`;

describe('parseFrontmatter recovery', () => {
  it('parses valid YAML exactly as before, with no recovery marker', () => {
    const raw = '---\nname: ok\nkeywords: [a, b]\nversion: 2\n---\n\nBody\n';
    const result = parseFrontmatter(raw);

    expect(result.data).toEqual({ name: 'ok', keywords: ['a', 'b'], version: 2 });
    expect(result.content).toBe('Body');
    expect(result.recovery).toBeUndefined();
  });

  it('recovers flow-looking and colon-bearing values by quoting them', () => {
    const result = parseFrontmatter(COMMAND_WITH_FLOW_LOOKING_VALUES);

    expect(result.recovery).toBe('quoted');
    expect(result.data.description).toBe('Plan a phase. Usage: run [N] times');
    expect(result.data['argument-hint']).toBe('[a] [b]');
    expect(result.data['allowed-tools']).toBe('Read, Bash');
    expect(result.content).toBe('# Plan\n\nBody text.');
  });

  it('keeps valid typed values untouched while quoting only the broken line', () => {
    const raw = '---\nkeywords: [x, y]\nversion: 3\nargument-hint: [a] [b]\n---\nBody';
    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('quoted');
    expect(result.data.keywords).toEqual(['x', 'y']);
    expect(result.data.version).toBe(3);
    expect(result.data['argument-hint']).toBe('[a] [b]');
  });

  it('does not quote the first line of a multi-line flow sequence', () => {
    // "tools: [Read," fails on its own only because its structure continues below.
    // Quoting it would cut the sequence in half and defeat the whole quoting step.
    const raw = '---\nname: multi\ntools: [Read,\n  Grep]\nargument-hint: [a] [b]\n---\nBody';
    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('quoted');
    expect(result.data.tools).toEqual(['Read', 'Grep']);
    expect(result.data['argument-hint']).toBe('[a] [b]');
  });

  it('keeps a YAML alias reference instead of quoting it into literal text', () => {
    // "copy: *base" fails on its own because the anchor lives on another line, but it
    // is valid in context. Quoting it would silently turn the alias into the text "*base".
    const raw =
      '---\nname: alias\nbase: &base shared\ncopy: *base\nargument-hint: [a] [b]\n---\nBody';
    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('quoted');
    expect(result.data.copy).toBe('shared');
    expect(result.data['argument-hint']).toBe('[a] [b]');
  });

  it('escapes double quotes and backslashes in values it quotes', () => {
    const raw = '---\ndescription: Say "hi" to C:\\dir. Usage: run [N]\n---\nBody';
    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('quoted');
    expect(result.data.description).toBe('Say "hi" to C:\\dir. Usage: run [N]');
  });

  it('falls back to a line-based extraction for a column-0 hooks body', () => {
    const result = parseFrontmatter(AGENT_WITH_COLUMN_ZERO_HOOKS);

    expect(result.recovery).toBe('line-based');
    expect(result.data.name).toBe('synthetic-reviewer');
    expect(result.data.description).toBe('Reviews synthetic diffs for the recovery tests');
    expect(result.content.startsWith('You are a synthetic reviewer.')).toBe(true);
  });

  it('reads a block-scalar description in the line-based fallback', () => {
    const raw = [
      '---',
      'name: block-desc',
      'description: >',
      '  First line',
      '  second line',
      'hooks:',
      '  pre: |',
      '    echo a',
      'stray --flag="x"',
      '---',
      'Body',
    ].join('\n');
    const result = parseFrontmatter(raw);

    expect(result.recovery).toBe('line-based');
    expect(result.data.name).toBe('block-desc');
    expect(result.data.description).toBe('First line second line');
  });

  it('still throws when nothing can be recovered', () => {
    const raw = '---\nhooks:\n  pre: |\n    echo a\nstray --flag="x"\n---\nBody';

    expect(() => parseFrontmatter(raw)).toThrow();
  });

  it('still throws for an unterminated frontmatter block with nothing recoverable', () => {
    expect(() => parseFrontmatter('---\nname: a\nbody with no closing fence')).toThrow();
  });

  it('returns empty data for a file with no frontmatter or with binary junk', () => {
    expect(parseFrontmatter('just some text').data).toEqual({});
    expect(parseFrontmatter('\u0000\u0001\u00ff').data).toEqual({});
  });
});

describe('parser integration with recovered frontmatter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fm-recovery-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes a command with flow-looking values and tags the recovery', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'plan.md'), COMMAND_WITH_FLOW_LOOKING_VALUES);

    const result = await parseCommands(commandsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('plan');
    expect(result.entries[0].description).toBe('Plan a phase. Usage: run [N] times');
    expect(result.entries[0].metadata.frontmatterRecovery).toBe('quoted');
    expect(result.entries[0].tags).toContain('frontmatter-warning');
  });

  it('indexes an agent with a column-0 hooks body with a warning tag and a ParseError', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'reviewer.md'), AGENT_WITH_COLUMN_ZERO_HOOKS);

    const result = await parseAgents(agentsDir);

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.name).toBe('synthetic-reviewer');
    expect(entry.description).toBe('Reviews synthetic diffs for the recovery tests');
    expect(entry.tags).toContain('frontmatter-warning');
    expect(entry.metadata.frontmatterRecovery).toBe('line-based');

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(join(agentsDir, 'reviewer.md'));
    expect(result.errors[0].message).toMatch(/^Recovered agent frontmatter/);
    expect(result.errors[0].message).toMatch(/line-based/);
  });

  it('does not index a file whose frontmatter is invalid and unrecoverable', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'hopeless.md'),
      '---\nhooks:\n  pre: |\n    echo a\nstray --flag="x"\n---\nBody',
    );

    const result = await parseAgents(agentsDir);

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/^Failed to parse agent/);
  });

  it('indexes files with no frontmatter and binary junk without throwing', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'plain.md'), 'No frontmatter here.\n');
    await writeFile(join(agentsDir, 'junk.md'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const result = await parseAgents(agentsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => e.name).sort()).toEqual(['junk', 'plain']);
    expect(result.entries.every((e) => e.metadata.frontmatterRecovery === undefined)).toBe(true);
  });

  it('flags recovery for subdirs-mode skills too', async () => {
    const skillsDir = join(tempDir, 'skills');
    await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
    await writeFile(
      join(skillsDir, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: Does things. Usage: run [N]\n---\nBody\n',
    );

    const result = await parseSkills(skillsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].description).toBe('Does things. Usage: run [N]');
    expect(result.entries[0].metadata.frontmatterRecovery).toBe('quoted');
  });
});
