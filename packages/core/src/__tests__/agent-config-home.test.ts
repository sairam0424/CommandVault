import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Vault } from '../vault.js';
import type { ParserResult } from '../types/index.js';

/**
 * The agent-config detection reads two places that have nothing to do with each other: the account
 * home (`~/.aider.conf.yml`, `~/.continue/config.json`) and, only when one is given, a project
 * directory. Not knowing the home directory must cost the home part and nothing else, and an empty
 * HOME must resolve the way `paths.ts` resolves it for the Claude directory (the passwd home), not
 * to paths relative to wherever the scan runs.
 *
 * `node:os` is replaced per test, so a machine without a passwd entry is reproducible anywhere.
 * Every directory is a realpath, because macOS reports `process.cwd()` through /private.
 */

const ORIGINAL_CWD = process.cwd();
const HOME_UNAVAILABLE = 'uv_os_homedir returned ENOENT (no such file or directory)';
const PASSWD_UNAVAILABLE = 'uv_os_get_passwd returned ENOENT (no such file or directory)';

interface OsBehaviour {
  readonly homedir: () => string;
  readonly userInfo: () => { homedir: string };
}

let root: string;
let claudeDir: string;
let projectDir: string;
let runDir: string;
let passwdHome: string;
let vault: Vault | null;

async function writeFileIn(dir: string, relativePath: string, body: string): Promise<void> {
  const filePath = join(dir, ...relativePath.split('/'));
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, body);
}

function failing(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

/** The agent-config parser and the Vault, loaded against an `os` module that behaves as given. */
async function loadWith(os: OsBehaviour) {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    ...os,
  }));
  const [{ detectAgentConfigs }, { createVault }] = await Promise.all([
    import('../parsers/multi-agent-parser.js'),
    import('../vault.js'),
  ]);
  return { detectAgentConfigs, createVault };
}

const NO_HOME: OsBehaviour = {
  homedir: failing(HOME_UNAVAILABLE),
  userInfo: failing(PASSWD_UNAVAILABLE),
};

function filePaths(result: ParserResult): string[] {
  return result.entries.map((e) => e.filePath).sort();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cv-agent-home-')));
  claudeDir = join(root, 'claude');
  projectDir = join(root, 'project');
  runDir = join(root, 'run-here');
  passwdHome = join(root, 'passwd-home');
  await Promise.all([
    writeFileIn(
      claudeDir,
      'skills/one/SKILL.md',
      '---\nname: one\ndescription: first\n---\nBody.\n',
    ),
    writeFileIn(claudeDir, 'rules/claude-rule.md', '---\nname: claude-rule\n---\nBody.\n'),
    writeFileIn(projectDir, 'CLAUDE.md', '# project instructions\n'),
    writeFileIn(projectDir, '.cursorrules', '# project cursor\n'),
    writeFileIn(runDir, '.continue/config.json', JSON.stringify({ description: 'cwd' })),
    writeFileIn(runDir, '.aider.conf.yml', '# cwd aider\n'),
    writeFileIn(passwdHome, '.aider.conf.yml', '# passwd aider\nmodel: sonnet\n'),
    writeFileIn(passwdHome, '.continue/config.json', JSON.stringify({ description: 'passwd' })),
  ]);
  process.chdir(runDir);
  vault = null;
});

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  await vault?.dispose();
  vi.doUnmock('node:os');
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

describe('detectAgentConfigs when the home directory cannot be determined', () => {
  it('still returns the entries of an explicit project directory, with one error', async () => {
    const { detectAgentConfigs } = await loadWith(NO_HOME);

    const result = await detectAgentConfigs(projectDir);

    expect(filePaths(result)).toEqual([
      join(projectDir, '.cursorrules'),
      join(projectDir, 'CLAUDE.md'),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.severity).toBe('error');
    expect(result.errors[0]?.message).toContain('home directory');
    expect(result.errors[0]?.message).toContain(PASSWD_UNAVAILABLE);
  });

  it('reports one error and no entries when there is no project directory either', async () => {
    const { detectAgentConfigs } = await loadWith(NO_HOME);

    const result = await detectAgentConfigs();

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.severity).toBe('error');
  });

  it('reports the home failure and a missing project directory separately', async () => {
    const { detectAgentConfigs } = await loadWith(NO_HOME);

    const result = await detectAgentConfigs(join(root, 'no-such-dir'));

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not exist'),
        expect.stringContaining('home directory'),
      ]),
    );
  });
});

describe('Vault when the home directory cannot be determined', () => {
  it('keeps the rules, the other entries and the project entries, with one agent-configs error', async () => {
    const { createVault } = await loadWith(NO_HOME);
    const v = createVault({
      claudeConfigPath: claudeDir,
      dbPath: join(root, 'vault.db'),
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
      projectRoot: projectDir,
    });
    vault = v;

    await expect(v.initialize()).resolves.toBeDefined();

    expect(v.getEntriesByType('rule').map((e) => e.filePath)).toEqual(
      expect.arrayContaining([
        join(claudeDir, 'rules', 'claude-rule.md'),
        join(projectDir, 'CLAUDE.md'),
        join(projectDir, '.cursorrules'),
      ]),
    );
    expect(v.getEntriesByType('skill').map((e) => e.name)).toEqual(['one']);
    expect(v.getEntriesBySource('cursor')).toHaveLength(1);
    const problems = v.getErrors().filter((e) => e.parser === 'agent-configs');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('error');
    expect(problems[0]?.message).toContain(PASSWD_UNAVAILABLE);
  });

  it('keeps the rules and the other entries when no project is given', async () => {
    const { createVault } = await loadWith(NO_HOME);
    const v = createVault({
      claudeConfigPath: claudeDir,
      dbPath: join(root, 'vault.db'),
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
    });
    vault = v;

    await expect(v.initialize()).resolves.toBeDefined();

    expect(v.getEntriesByType('rule').map((e) => e.name)).toEqual(['claude-rule']);
    expect(v.getEntriesByType('skill').map((e) => e.name)).toEqual(['one']);
    expect(v.getErrors().filter((e) => e.parser === 'agent-configs')).toHaveLength(1);
  });
});

describe('detectAgentConfigs when os.homedir() throws but the passwd entry is known', () => {
  // Windows throws ENOENT from os.homedir() when USERPROFILE is unset, and still knows the profile.
  it('reads the home-level configs from the passwd home, without an error', async () => {
    const { detectAgentConfigs } = await loadWith({
      homedir: failing(HOME_UNAVAILABLE),
      userInfo: () => ({ homedir: passwdHome }),
    });

    const result = await detectAgentConfigs();

    expect(result.errors).toEqual([]);
    expect(filePaths(result)).toEqual([
      join(passwdHome, '.aider.conf.yml'),
      join(passwdHome, '.continue', 'config.json'),
    ]);
  });
});

describe('detectAgentConfigs when the home directory is empty', () => {
  // HOME set but empty makes os.homedir() return '', and join('', x) is relative to the current
  // directory. The account home is then the passwd home, as it is for the Claude directory.
  it('reads the passwd home and nothing relative to the current directory', async () => {
    const { detectAgentConfigs } = await loadWith({
      homedir: () => '',
      userInfo: () => ({ homedir: passwdHome }),
    });

    const result = await detectAgentConfigs();

    expect(result.errors).toEqual([]);
    expect(filePaths(result)).toEqual([
      join(passwdHome, '.aider.conf.yml'),
      join(passwdHome, '.continue', 'config.json'),
    ]);
    expect(result.entries.every((e) => isAbsolute(e.filePath))).toBe(true);
  });

  it('reads nothing, and reports it, when the passwd home is empty too', async () => {
    const { detectAgentConfigs } = await loadWith({
      homedir: () => '',
      userInfo: () => ({ homedir: '' }),
    });

    const result = await detectAgentConfigs();

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('home directory');
  });

  it('indexes the passwd home through a Vault, and nothing from the current directory', async () => {
    const { createVault } = await loadWith({
      homedir: () => '',
      userInfo: () => ({ homedir: passwdHome }),
    });
    const v = createVault({
      claudeConfigPath: claudeDir,
      dbPath: join(root, 'vault.db'),
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
    });
    vault = v;

    await v.initialize();

    expect(v.getAllEntries().filter((e) => !isAbsolute(e.filePath))).toEqual([]);
    expect(v.getAllEntries().filter((e) => e.filePath.startsWith(runDir))).toEqual([]);
    expect(v.getEntriesBySource('aider').map((e) => e.filePath)).toEqual([
      join(passwdHome, '.aider.conf.yml'),
    ]);
    expect(v.getErrors().filter((e) => e.parser === 'agent-configs')).toEqual([]);
  });
});
