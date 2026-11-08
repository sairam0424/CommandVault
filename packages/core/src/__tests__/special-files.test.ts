import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseAgents } from '../parsers/agent-parser.js';
import { parseCommands } from '../parsers/command-parser.js';
import { parseHooks } from '../parsers/hook-parser.js';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { parsePlugins } from '../parsers/plugin-parser.js';
import { readMarketplaceEntry } from '../parsers/plugin-resolution.js';
import { readBoundedText } from '../parsers/bounded-read.js';
import { withRetry } from '../parsers/retry.js';
import { getParseSeverity } from '../scan-pipeline.js';
import type { ParseError } from '../types/index.js';

/**
 * A scan must never block or amplify on something that is not a regular file. A FIFO with no
 * writer used to hang `open` until one appeared (`vault list` never returned), a symlink to
 * /dev/zero read until the string limit, and both were reported, if at all, for the wrong reason.
 * Every parser call here must return inside HANG_BUDGET_MS (the old reader fails them by timeout).
 * Building a fixture spawns processes, mkfifo and a node child binding a socket, whose start-up
 * depends on machine load, so it is not timed.
 */

const IS_WINDOWS = process.platform === 'win32';
const HANG_BUDGET_MS = 2000;
const NEIGHBOUR = '---\ndescription: neighbour\n---\nBody\n';

/**
 * Binds a Unix socket at `path` from a child process that changes into the directory first, so
 * the name handed to the kernel is the short basename (sun_path is 104 bytes on macOS). The file
 * outlives the child: a socket nobody listens on still cannot be opened as a file.
 */
const BIND_SOCKET_SCRIPT =
  'process.chdir(process.argv[1]);' +
  'require("node:net").createServer().listen(process.argv[2], () => process.exit(0));';

function createSocketFile(path: string): void {
  execFileSync(process.execPath, ['-e', BIND_SOCKET_SCRIPT, dirname(path), basename(path)]);
}

function createFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

/** Holds only the parser call to the hang budget; the old reader never returns from a FIFO. */
async function withinHangBudget<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the parser did not return within ${HANG_BUDGET_MS} ms`)),
      HANG_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function expectOneSkipWarning(
  errors: readonly ParseError[],
  filePath: string,
  fragment: string,
): ParseError {
  const matching = errors.filter((e) => e.filePath === filePath);
  expect(matching).toHaveLength(1);
  const [warning] = matching;
  expect(getParseSeverity(warning)).toBe('warning');
  expect(warning.message).toMatch(/^Skipped /);
  expect(warning.message).toContain(fragment);
  expect(warning.message).toContain('not a regular file');
  return warning;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-special-files-')));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS)('special files are refused without blocking', () => {
  it('commands: a FIFO is skipped with a warning and its neighbours are indexed', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir);
    await writeFile(join(commandsDir, 'ok.md'), NEIGHBOUR);
    const fifoPath = join(commandsDir, 'pipe.md');
    createFifo(fifoPath);

    const result = await withinHangBudget(() => parseCommands(commandsDir));

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    const warning = expectOneSkipWarning(result.errors, fifoPath, 'FIFO');
    expect(warning.message).toContain(fifoPath);
  });

  it('project: a FIFO CLAUDE.md is skipped with a warning and the other configs are indexed', async () => {
    const projectRoot = join(tempDir, 'project');
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, '.cursorrules'), '# Rules\nBe nice.\n');
    const fifoPath = join(projectRoot, 'CLAUDE.md');
    createFifo(fifoPath);

    const result = await withinHangBudget(() => detectAgentConfigs(projectRoot));

    expect(result.entries.map((e) => basename(e.filePath))).toEqual(['.cursorrules']);
    expectOneSkipWarning(result.errors, fifoPath, 'FIFO');
  });

  it('hooks: a FIFO hook script keeps the hook, warns, and never reads the script', async () => {
    const fifoPath = join(tempDir, 'hook.js');
    createFifo(fifoPath);
    const settingsPath = join(tempDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${fifoPath}` }] }],
        },
      }),
    );

    const result = await withinHangBudget(() => parseHooks(settingsPath));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toBe(`// Script at: ${fifoPath}`);
    expectOneSkipWarning(result.errors, fifoPath, 'FIFO');
  });

  it('agents: a symlink to /dev/zero is skipped as a device, not as an oversized file', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir);
    await writeFile(join(agentsDir, 'ok.md'), NEIGHBOUR);
    const zeroPath = join(agentsDir, 'zero.md');
    await symlink('/dev/zero', zeroPath);

    const result = await withinHangBudget(() => parseAgents(agentsDir));

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    const warning = expectOneSkipWarning(result.errors, zeroPath, 'character device');
    expect(warning.message).not.toMatch(/MiB|read limit|string length/);
  });

  it('commands: a Unix socket is skipped with a warning', async () => {
    const commandsDir = join(tempDir, 'commands');
    await mkdir(commandsDir);
    await writeFile(join(commandsDir, 'ok.md'), NEIGHBOUR);
    const socketPath = join(commandsDir, 'sock.md');
    createSocketFile(socketPath);

    const result = await withinHangBudget(() => parseCommands(commandsDir));

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    expectOneSkipWarning(result.errors, socketPath, 'socket');
  });

  it('agents: a directory named like a markdown file is skipped with a warning', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir);
    await writeFile(join(agentsDir, 'ok.md'), NEIGHBOUR);
    const dirPath = join(agentsDir, 'folder.md');
    await mkdir(dirPath);

    const result = await withinHangBudget(() => parseAgents(agentsDir));

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    expectOneSkipWarning(result.errors, dirPath, 'directory');
  });

  it('the reader is tried exactly once for a FIFO: a refusal is not a transient failure', async () => {
    const fifoPath = join(tempDir, 'pipe.md');
    createFifo(fifoPath);
    const read = vi.fn(() => readBoundedText(fifoPath));

    await expect(withinHangBudget(() => withRetry(read))).rejects.toThrow(
      /FIFO, not a regular file/,
    );

    expect(read).toHaveBeenCalledTimes(1);
  });

  // The JSON files the parsers read are special-file cases of their own: each reader has to turn a
  // refusal into a warning rather than the generic "not found" or "unreadable" error.
  it('settings.json: a FIFO is skipped with a warning', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    createFifo(settingsPath);

    const result = await withinHangBudget(() => parseHooks(settingsPath));

    expect(result.entries).toEqual([]);
    expectOneSkipWarning(result.errors, settingsPath, 'FIFO');
  });

  it('installed_plugins.json: a FIFO is skipped with a warning', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    await mkdir(pluginsDir);
    const registryPath = join(pluginsDir, 'installed_plugins.json');
    createFifo(registryPath);

    const result = await withinHangBudget(() => parsePlugins(pluginsDir));

    expect(result.entries).toEqual([]);
    expectOneSkipWarning(result.errors, registryPath, 'FIFO');
  });

  it('a plugin manifest that is a FIFO is skipped with a warning', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    const installPath = join(pluginsDir, 'cache', 'market', 'plug', '1.0.0');
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
    const manifestPath = join(installPath, '.claude-plugin', 'plugin.json');
    createFifo(manifestPath);
    const install = {
      scope: 'user',
      installPath,
      version: '1.0.0',
      installedAt: '',
      lastUpdated: '',
    };
    const registry = { version: 2, plugins: { 'plug@market': [install] } };
    await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify(registry));

    const result = await withinHangBudget(() => parsePlugins(pluginsDir));

    expectOneSkipWarning(result.errors, manifestPath, 'FIFO');
  });

  it('a marketplace file that is a FIFO is skipped with a warning', async () => {
    const pluginsDir = join(tempDir, 'plugins');
    const listingDir = join(pluginsDir, 'marketplaces', 'market', '.claude-plugin');
    await mkdir(listingDir, { recursive: true });
    const listingPath = join(listingDir, 'marketplace.json');
    createFifo(listingPath);
    const warnings: ParseError[] = [];

    const found = await withinHangBudget(() =>
      readMarketplaceEntry(pluginsDir, 'plug@market', warnings),
    );

    expect(found).toBeNull();
    expectOneSkipWarning(warnings, listingPath, 'FIFO');
  });
});
