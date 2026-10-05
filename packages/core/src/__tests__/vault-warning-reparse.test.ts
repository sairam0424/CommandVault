import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from '../vault.js';
import { MAX_PARSE_FILE_BYTES } from '../constants.js';

/**
 * A warning that names a file outside the Claude config directories (a hook script, a plugin
 * install dir) cannot be routed to its parser by path. Each one must carry its parser, or every
 * re-run of that parser appends the same warning again. These tests drive a real Vault, as the
 * watcher and `scanSingle` do, and count the warnings after each re-run.
 */

const OVER_CAP = MAX_PARSE_FILE_BYTES + 1;
const RERUNS = 3;

let root: string;
let claudeDir: string;
let vault: Vault | null;

async function openVault(): Promise<Vault> {
  vi.resetModules();
  const { createVault } = await import('../vault.js');
  const opened = createVault({
    claudeConfigPath: claudeDir,
    dbPath: join(root, 'vault.db'),
    enableWatcher: false,
    defaultSearchTier: 'minisearch',
    projectRoot: join(root, 'project'),
  });
  vault = opened;
  return opened;
}

async function writeSparse(filePath: string, size: number): Promise<void> {
  await writeFile(filePath, '');
  await truncate(filePath, size);
}

async function writeRegistry(key: string, installPath: string): Promise<void> {
  const install = {
    scope: 'user',
    installPath,
    version: '1.0.0',
    installedAt: '',
    lastUpdated: '',
  };
  await mkdir(join(claudeDir, 'plugins'), { recursive: true });
  await writeFile(
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [key]: [install] } }),
  );
}

/** Warnings mentioning `needle`, counted after the initial scan and after each `scanSingle` re-run. */
async function countAcrossReruns(parser: 'hook' | 'plugin', needle: string): Promise<number[]> {
  const opened = await openVault();
  await opened.initialize();
  const counts = [opened.getErrors().filter((e) => e.message.includes(needle)).length];
  for (let run = 0; run < RERUNS; run += 1) {
    await opened.scanSingle(parser);
    counts.push(opened.getErrors().filter((e) => e.message.includes(needle)).length);
  }
  return counts;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cv-warning-reparse-')));
  claudeDir = join(root, 'claude');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(join(root, 'project'), { recursive: true });
  vault = null;
});

afterEach(async () => {
  await vault?.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('a warning about a file outside the Claude config directories', () => {
  it('hook script too large: one warning however often the hook parser re-runs', async () => {
    const scriptPath = join(claudeDir, 'hooks', 'big.js');
    await mkdir(join(claudeDir, 'hooks'), { recursive: true });
    await writeSparse(scriptPath, OVER_CAP);
    const hook = { type: 'command', command: `node ${scriptPath}` };
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [hook] }] } }),
    );

    expect(await countAcrossReruns('hook', 'big.js')).toEqual([1, 1, 1, 1]);
  });

  it('plugin manifest too large: one warning however often the plugin parser re-runs', async () => {
    const installPath = join(claudeDir, 'plugins', 'cache', 'big-plugin');
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
    await writeSparse(join(installPath, '.claude-plugin', 'plugin.json'), OVER_CAP);
    await writeRegistry('big@market', installPath);

    expect(await countAcrossReruns('plugin', 'plugin manifest')).toEqual([1, 1, 1, 1]);
  });

  it('plugin with no manifest and no listing: one warning however often it re-runs', async () => {
    await writeRegistry('ghost@market', join(claudeDir, 'plugins', 'cache', 'ghost-plugin'));

    expect(await countAcrossReruns('plugin', 'ghost@market')).toEqual([1, 1, 1, 1]);
  });

  it('plugin install path outside the plugins directory: one error however often it re-runs', async () => {
    await writeRegistry('stray@market', join(root, 'elsewhere', 'stray-plugin'));

    expect(await countAcrossReruns('plugin', 'outside plugins directory')).toEqual([1, 1, 1, 1]);
  });
});
