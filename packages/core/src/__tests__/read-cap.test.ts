import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, mkdir, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_PARSE_FILE_BYTES } from '../constants.js';
import { FileTooLargeError, readBoundedText } from '../parsers/bounded-read.js';
import { parseAgents } from '../parsers/agent-parser.js';
import { parseCommands } from '../parsers/command-parser.js';
import { parseHooks } from '../parsers/hook-parser.js';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { parsePlugins } from '../parsers/plugin-parser.js';
import { parseRules } from '../parsers/rule-parser.js';
import { parseSingleFile } from '../parsers/single-file-parser.js';
import { parseSkills } from '../parsers/skill-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';

const OVER_CAP = MAX_PARSE_FILE_BYTES + 1;
const OVER_CAP_LABEL = '32.0 MiB';

let tempDir: string;

beforeEach(async () => {
  // Resolved so hook-script containment (which compares real paths) holds where tmpdir is a symlink.
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-read-cap-')));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** A file that reports `size` bytes without storing them, so the suite stays fast. */
async function writeSparse(filePath: string, size: number): Promise<void> {
  await writeFile(filePath, '');
  await truncate(filePath, size);
}

function expectSkipWarning(
  errors: readonly { filePath: string; message: string; severity?: string }[],
  filePath: string,
): void {
  expect(errors).toHaveLength(1);
  expect(errors[0].filePath).toBe(filePath);
  expect(errors[0].message).toContain(filePath);
  expect(errors[0].message).toContain(OVER_CAP_LABEL);
  expect(getParseSeverity(errors[0] as never)).toBe('warning');
}

describe('MAX_PARSE_FILE_BYTES', () => {
  it('is 32 MiB', () => {
    expect(MAX_PARSE_FILE_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('readBoundedText', () => {
  it('reads a file that is exactly at the limit', async () => {
    const filePath = join(tempDir, 'edge.md');
    await writeFile(filePath, '12345');

    await expect(readBoundedText(filePath, 5)).resolves.toBe('12345');
  });

  it('refuses a file one byte over the limit (read order: bounded-read-order.test.ts)', async () => {
    const filePath = join(tempDir, 'over.md');
    await writeFile(filePath, '123456');

    const failure = await readBoundedText(filePath, 5).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(FileTooLargeError);
    const error = failure as FileTooLargeError;
    expect(error.filePath).toBe(filePath);
    expect(error.sizeBytes).toBe(6);
    expect(error.limitBytes).toBe(5);
  });

  it('propagates a missing file as ENOENT', async () => {
    await expect(readBoundedText(join(tempDir, 'missing.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('markdown parsers skip an oversized file with a warning', () => {
  it('commands: skips the big file, keeps its neighbours', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'small.md'), '---\ndescription: small\n---\nBody');
    const bigPath = join(commandsDir, 'big.md');
    await writeSparse(bigPath, OVER_CAP);

    const result = await parseCommands(commandsDir);

    expect(result.entries.map((e) => e.name)).toEqual(['small']);
    expectSkipWarning(result.errors, bigPath);
  });

  it('skills: skips the big SKILL.md', async () => {
    const skillsDir = join(tempDir, 'skills');
    await mkdir(join(skillsDir, 'huge'), { recursive: true });
    const bigPath = join(skillsDir, 'huge', 'SKILL.md');
    await writeSparse(bigPath, OVER_CAP);

    const result = await parseSkills(skillsDir);

    expect(result.entries).toEqual([]);
    expectSkipWarning(result.errors, bigPath);
  });

  it('agents: skips the big file', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    const bigPath = join(agentsDir, 'huge.md');
    await writeSparse(bigPath, OVER_CAP);

    const result = await parseAgents(agentsDir);

    expect(result.entries).toEqual([]);
    expectSkipWarning(result.errors, bigPath);
  });

  it('rules: skips the big file', async () => {
    const rulesDir = join(tempDir, 'rules');
    await mkdir(rulesDir, { recursive: true });
    const bigPath = join(rulesDir, 'huge.md');
    await writeSparse(bigPath, OVER_CAP);

    const result = await parseRules(rulesDir);

    expect(result.entries).toEqual([]);
    expectSkipWarning(result.errors, bigPath);
  });

  it('indexes a file exactly at the limit as before', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeSparse(join(commandsDir, 'edge.md'), MAX_PARSE_FILE_BYTES);

    const result = await parseCommands(commandsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => e.name)).toEqual(['edge']);
  });

  it('does not report a normal failure as a size skip', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'hopeless.md'),
      '---\nhooks:\n  pre: |\n    x\nstray --a="b"\n---\n',
    );

    const result = await parseAgents(agentsDir);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/^Failed to parse agent/);
    expect(getParseSeverity(result.errors[0])).toBe('error');
  });
});

describe('the watcher single-file path', () => {
  it('returns null for an oversized file instead of reading it', async () => {
    const bigPath = join(tempDir, 'big.md');
    await writeSparse(bigPath, OVER_CAP);

    await expect(parseSingleFile(bigPath, 'command')).resolves.toBeNull();
  });
});

describe('JSON and project config readers', () => {
  it('plugins: an oversized registry is skipped with a warning', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
    const registryPath = join(pluginsDir, 'installed_plugins.json');
    await writeSparse(registryPath, OVER_CAP);

    const result = await parsePlugins(pluginsDir);

    expect(result.entries).toEqual([]);
    expectSkipWarning(result.errors, registryPath);
  });

  it('plugins: an oversized manifest is skipped with a warning and the plugin still indexed', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    const installPath = join(pluginsDir, 'cache', 'big');
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
    const manifestPath = join(installPath, '.claude-plugin', 'plugin.json');
    await writeSparse(manifestPath, OVER_CAP);
    const install = {
      scope: 'user',
      installPath,
      version: '1.0.0',
      installedAt: '',
      lastUpdated: '',
    };
    await writeFile(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'big@market': [install] } }),
    );

    const result = await parsePlugins(pluginsDir);

    expect(result.entries.map((e) => e.name)).toEqual(['big']);
    // The skipped manifest also leaves the plugin undescribed, which is reported separately.
    expectSkipWarning(
      result.errors.filter((e) => e.filePath === manifestPath),
      manifestPath,
    );
  });

  it('plugins: a manifest under the limit is read as before', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    const installPath = join(pluginsDir, 'cache', 'ok');
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(installPath, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ok', description: 'fine' }),
    );
    const install = {
      scope: 'user',
      installPath,
      version: '1.0.0',
      installedAt: '',
      lastUpdated: '',
    };
    await writeFile(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'ok@market': [install] } }),
    );

    const result = await parsePlugins(pluginsDir);

    expect(result.errors).toEqual([]);
    expect(result.entries[0].description).toBe('fine');
  });

  it('hooks: an oversized settings file is skipped with a warning', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    await writeSparse(settingsPath, OVER_CAP);

    const result = await parseHooks(settingsPath);

    expect(result.entries).toEqual([]);
    expectSkipWarning(result.errors, settingsPath);
  });

  it('hooks: an oversized hook script keeps the hook but warns and does not load the script', async () => {
    const scriptPath = join(tempDir, 'huge-hook.js');
    await writeSparse(scriptPath, OVER_CAP);
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${scriptPath}` }] }],
        },
      }),
    );

    const result = await parseHooks(settingsPath);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toContain(scriptPath);
    expect(result.entries[0].content.length).toBeLessThan(1024);
    expectSkipWarning(result.errors, scriptPath);
  });

  it('agent configs: an oversized project config is skipped with a warning', async () => {
    const projectRoot = join(tempDir, 'project');
    await mkdir(projectRoot, { recursive: true });
    const bigPath = join(projectRoot, '.cursorrules');
    await writeSparse(bigPath, OVER_CAP);

    const result = await detectAgentConfigs(projectRoot);

    expect(result.entries.filter((e) => e.filePath === bigPath)).toEqual([]);
    expectSkipWarning(
      result.errors.filter((e) => e.filePath === bigPath),
      bigPath,
    );
  });

  it('agent configs: an oversized markdown rule in a config directory is skipped with a warning', async () => {
    const projectRoot = join(tempDir, 'project');
    const rulesDir = join(projectRoot, '.cursor', 'rules');
    await mkdir(rulesDir, { recursive: true });
    const bigPath = join(rulesDir, 'huge.md');
    await writeSparse(bigPath, OVER_CAP);

    const result = await detectAgentConfigs(projectRoot);

    expect(result.entries.filter((e) => e.filePath === bigPath)).toEqual([]);
    expectSkipWarning(
      result.errors.filter((e) => e.filePath === bigPath),
      bigPath,
    );
  });
});
