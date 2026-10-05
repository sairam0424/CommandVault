import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ParseError, VaultEntry } from '../types/index.js';
import * as core from '../index.js';
import {
  dedupeEntriesById,
  getParseSeverity,
  partitionValidEntries,
  runParserSafely,
} from '../scan-pipeline.js';
import { MAX_DESCRIPTION_LENGTH, MAX_PARSE_FILE_BYTES } from '../constants.js';
import { FRONTMATTER_WARNING_TAG } from '../parsers/base-parser.js';
import { parseAgents } from '../parsers/agent-parser.js';
import { parseCommands } from '../parsers/command-parser.js';
import { parsePlugins } from '../parsers/plugin-parser.js';
import { parseHooks } from '../parsers/hook-parser.js';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { generateStableId, inferSource } from '../parsers/utils.js';

const COLUMN_ZERO_HOOKS_AGENT = `---
name: "synthetic-reviewer"
description: "Reviews synthetic diffs"
hooks:
  pre: |
    echo "activated: $TASK"
run-the-scan --target="$TASK"
---
You are a synthetic reviewer.
`;

const QUOTED_RECOVERY_COMMAND = `---
description: Plan a phase. Usage: run [N] times
argument-hint: [a] [b]
---

# Plan

Body text.
`;

const UNRECOVERABLE = '---\nhooks:\n  pre: |\n    echo a\nstray --flag="x"\n---\nBody';

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

describe('getParseSeverity', () => {
  it('reads an explicit severity and treats a missing one as an error', () => {
    const base: ParseError = { filePath: '/x', message: 'm' };

    expect(getParseSeverity({ ...base, severity: 'warning' })).toBe('warning');
    expect(getParseSeverity({ ...base, severity: 'error' })).toBe('error');
    expect(getParseSeverity(base)).toBe('error');
  });

  it('is exported from the package root for consumers', () => {
    expect(core.getParseSeverity).toBe(getParseSeverity);
  });

  it('exports the parse constants and the severity type from the package root', () => {
    const severity: core.ParseSeverity = 'warning';

    expect(severity).toBe('warning');
    expect(core.FRONTMATTER_WARNING_TAG).toBe(FRONTMATTER_WARNING_TAG);
    expect(core.MAX_PARSE_FILE_BYTES).toBe(MAX_PARSE_FILE_BYTES);
    expect(core.MAX_DESCRIPTION_LENGTH).toBe(MAX_DESCRIPTION_LENGTH);
    expect(core.FRONTMATTER_WARNING_TAG).toBe('frontmatter-warning');
    expect(core.MAX_PARSE_FILE_BYTES).toBe(32 * 1024 * 1024);
    expect(core.MAX_DESCRIPTION_LENGTH).toBe(200);
  });
});

describe('ParseError severity per source', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-severity-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('marks a line-based frontmatter recovery as a warning', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'reviewer.md'), COLUMN_ZERO_HOOKS_AGENT);

    const result = await parseAgents(agentsDir);

    expect(result.entries).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/^Recovered agent frontmatter/);
    expect(result.errors[0].severity).toBe('warning');
  });

  it('marks a file that cannot be parsed as an error', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'hopeless.md'), UNRECOVERABLE);

    const result = await parseAgents(agentsDir);

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/^Failed to parse agent/);
    expect(result.errors[0].severity).toBe('error');
  });

  it('marks a missing directory as an error', async () => {
    const result = await parseAgents(join(tempDir, 'nope'));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].severity).toBe('error');
  });

  it('marks a missing plugin registry as an error', async () => {
    const result = await parsePlugins(join(tempDir, 'plugins'));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].severity).toBe('error');
  });

  it('marks a blocked installPath and a malformed registry entry as errors', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
    const install = { scope: 'user', version: '1', installedAt: '', lastUpdated: '' };
    const registry = {
      version: 2,
      plugins: {
        'escape@m': [{ ...install, installPath: join(tempDir, 'elsewhere') }],
        'broken@m': 'not-an-array',
      },
    };
    await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify(registry));

    const result = await parsePlugins(pluginsDir);

    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.severity)).toEqual(['error', 'error']);
  });

  it('marks invalid settings JSON and an invalid hook as errors', async () => {
    const badJson = join(tempDir, 'bad.json');
    await writeFile(badJson, '{ nope');
    const badHook = join(tempDir, 'badhook.json');
    await writeFile(
      badHook,
      JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command' }] }] } }),
    );

    const [invalid, hook] = await Promise.all([parseHooks(badJson), parseHooks(badHook)]);

    expect(invalid.errors.map((e) => e.severity)).toEqual(['error']);
    expect(hook.errors.map((e) => e.severity)).toEqual(['error']);
  });

  it('marks settings and a plugin registry of the wrong shape as errors', async () => {
    const settingsPath = join(tempDir, 'array.json');
    await writeFile(settingsPath, '[]');
    const pluginsDir = join(tempDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, 'installed_plugins.json'), '{"version":2}');

    const [hooks, plugins] = await Promise.all([
      parseHooks(settingsPath),
      parsePlugins(pluginsDir),
    ]);

    expect(hooks.errors.map((e) => e.severity)).toEqual(['error']);
    expect(plugins.errors.map((e) => e.severity)).toEqual(['error']);
  });

  it('marks an unreadable project agent config as an error', async () => {
    const projectRoot = join(tempDir, 'project');
    // A directory where a file is expected: it exists, so detection tries to read it and fails.
    await mkdir(join(projectRoot, '.cursorrules'), { recursive: true });

    const result = await detectAgentConfigs(projectRoot);

    const failures = result.errors.filter((e) => e.filePath.endsWith('.cursorrules'));
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toMatch(/^Failed to parse Cursor Rules/);
    expect(failures[0].severity).toBe('error');
  });
});

describe('ParseError severity in the scan pipeline', () => {
  it('marks a dropped duplicate id as a warning', () => {
    const winner = makeEntry({ filePath: '/a/SKILL.md' });
    const loser = makeEntry({ filePath: '/b/SKILL.md' });

    const { errors } = dedupeEntriesById([winner, loser]);

    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe('warning');
  });

  it('marks a parser that throws as an error', async () => {
    const result = await runParserSafely('skill', '/claude/skills', async () => {
      throw new Error('boom');
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].severity).toBe('error');
  });

  it('marks a malformed parser result as an error', async () => {
    const result = await runParserSafely('skill', '/claude/skills', () => ({}) as never);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].severity).toBe('error');
  });

  it('marks a rejected record as an error', async () => {
    const result = await runParserSafely('skill', '/claude/skills', () => ({
      entries: [{ nonsense: true } as unknown as VaultEntry],
      errors: [],
    }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/^Rejected skill record #0/);
    expect(result.errors[0].severity).toBe('error');
  });

  it('keeps a parser the error already names', async () => {
    const result = await runParserSafely('skill', '/claude/skills', () => ({
      entries: [],
      errors: [{ filePath: '/a', message: 'dup', severity: 'warning', parser: 'agent' }],
    }));

    expect(result.errors).toEqual([
      { filePath: '/a', message: 'dup', severity: 'warning', parser: 'agent' },
    ]);
  });

  it('marks a rejected batch as an error', () => {
    const { errors } = partitionValidEntries(null as never, 'import');

    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe('error');
  });

  it('keeps the severity a parser reported, warning or absent, and names the parser', async () => {
    const result = await runParserSafely('skill', '/claude/skills', () => ({
      entries: [],
      errors: [
        { filePath: '/a', message: 'soft', severity: 'warning' },
        { filePath: '/b', message: 'plain' },
      ],
    }));

    expect(result.errors).toEqual([
      { filePath: '/a', message: 'soft', severity: 'warning', parser: 'skill' },
      { filePath: '/b', message: 'plain', parser: 'skill' },
    ]);
  });
});

describe('quoted frontmatter recovery is discoverable', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-quoted-tag-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('tags a quoted recovery like a line-based one and keeps the metadata marker', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'plan.md'), QUOTED_RECOVERY_COMMAND);

    const result = await parseCommands(commandsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.metadata.frontmatterRecovery).toBe('quoted');
    expect(entry.tags.filter((tag) => tag === 'frontmatter-warning')).toEqual([
      'frontmatter-warning',
    ]);
  });

  it('leaves the id unaffected by the tag', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir, { recursive: true });
    const filePath = join(commandsDir, 'plan.md');
    await writeFile(filePath, QUOTED_RECOVERY_COMMAND);

    const [entry] = (await parseCommands(commandsDir)).entries;

    expect(entry.id).toBe(generateStableId('command', 'plan', inferSource('plan', filePath)));
  });

  it('does not tag a file whose frontmatter parsed strictly', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'ok.md'), '---\ndescription: fine\n---\nBody');

    const [entry] = (await parseCommands(commandsDir)).entries;

    expect(entry.tags).not.toContain('frontmatter-warning');
    expect(entry.metadata.frontmatterRecovery).toBeUndefined();
  });
});
