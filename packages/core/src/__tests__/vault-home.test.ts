import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from '../vault.js';
import { createVault } from '../vault.js';

/**
 * Vault used to read the home directory into module-level constants, so COMMANDVAULT_HOME and a
 * HOME set after import were ignored, and initialize() always created ~/.commandvault even when
 * the caller passed its own dbPath (CV-G2-094).
 */

const IS_POSIX = process.platform !== 'win32';

/** Where the module-level constants pointed when this file was loaded. */
const HOME_AT_IMPORT = homedir();

let root: string;
let fakeHome: string;
let claudeDir: string;
let projectRoot: string;
let vault: Vault | null;

async function writeSkill(dir: string, name: string): Promise<void> {
  const skillDir = join(dir, 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: skill ${name}\n---\nBody of ${name}.\n`,
  );
}

function skillNames(v: Vault): string[] {
  return v
    .getEntriesByType('skill')
    .map((entry) => entry.name)
    .sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cv-vault-home-'));
  fakeHome = join(root, 'home');
  claudeDir = join(root, 'claude');
  projectRoot = join(root, 'project');
  await Promise.all([
    mkdir(fakeHome, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    writeSkill(claudeDir, 'from-explicit-claude-path'),
  ]);
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('COMMANDVAULT_HOME', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vault = null;
});

afterEach(async () => {
  await vault?.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function open(config: Parameters<typeof createVault>[0]): Vault {
  vault = createVault({ enableWatcher: false, projectRoot, ...config });
  return vault;
}

describe('Vault data directory', () => {
  it('creates vault.db under COMMANDVAULT_HOME, set after the module was imported', async () => {
    const dataDir = join(root, 'env-data', 'nested');
    vi.stubEnv('COMMANDVAULT_HOME', dataDir);

    await open({ claudeConfigPath: claudeDir }).initialize();

    expect(existsSync(join(dataDir, 'vault.db'))).toBe(true);
    expect(existsSync(join(fakeHome, '.commandvault'))).toBe(false);
    expect(existsSync(join(HOME_AT_IMPORT, '.commandvault', 'vault.db'))).toBe(false);
  });

  it.skipIf(!IS_POSIX)('creates a data directory it had to make with mode 0700', async () => {
    const dataDir = join(root, 'private-data');
    vi.stubEnv('COMMANDVAULT_HOME', dataDir);

    await open({ claudeConfigPath: claudeDir }).initialize();

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('falls back to <HOME>/.commandvault when COMMANDVAULT_HOME is unset, using the current HOME', async () => {
    await open({ claudeConfigPath: claudeDir }).initialize();

    expect(existsSync(join(fakeHome, '.commandvault', 'vault.db'))).toBe(true);
    expect(existsSync(join(HOME_AT_IMPORT, '.commandvault', 'vault.db'))).toBe(false);
  });

  it('creates only the directory of an explicit dbPath, never the default data directory', async () => {
    const dbPath = join(root, 'custom', 'deep', 'vault.db');
    const envData = join(root, 'env-data');
    vi.stubEnv('COMMANDVAULT_HOME', envData);

    await open({ claudeConfigPath: claudeDir, dbPath }).initialize();

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(envData)).toBe(false);
    expect(existsSync(join(fakeHome, '.commandvault'))).toBe(false);
  });

  it('creates nothing under a freshly imported HOME when the caller gives its own dbPath', async () => {
    // A fresh import is what the old module-level constants were sensitive to: they bound HOME here.
    vi.resetModules();
    const { createVault: createFreshVault } = await import('../vault.js');
    const fresh = createFreshVault({
      claudeConfigPath: claudeDir,
      dbPath: join(root, 'solo', 'vault.db'),
      enableWatcher: false,
      projectRoot,
    });

    try {
      await fresh.initialize();
    } finally {
      await fresh.dispose();
    }

    expect(existsSync(join(root, 'solo', 'vault.db'))).toBe(true);
    expect(existsSync(join(fakeHome, '.commandvault'))).toBe(false);
  });
});

describe('Vault Claude directory', () => {
  it('scans CLAUDE_CONFIG_DIR when no claudeConfigPath is given', async () => {
    const fromEnv = join(root, 'claude-from-env');
    await writeSkill(fromEnv, 'from-env');
    vi.stubEnv('CLAUDE_CONFIG_DIR', fromEnv);

    const v = open({ dbPath: join(root, 'db', 'vault.db') });
    await v.initialize();

    expect(skillNames(v)).toEqual(['from-env']);
  });

  it('scans <HOME>/.claude using the current HOME when CLAUDE_CONFIG_DIR is unset', async () => {
    await writeSkill(join(fakeHome, '.claude'), 'from-home');

    const v = open({ dbPath: join(root, 'db', 'vault.db') });
    await v.initialize();

    expect(skillNames(v)).toEqual(['from-home']);
  });

  it('lets an explicit claudeConfigPath win over CLAUDE_CONFIG_DIR', async () => {
    const fromEnv = join(root, 'claude-from-env');
    await writeSkill(fromEnv, 'from-env');
    vi.stubEnv('CLAUDE_CONFIG_DIR', fromEnv);

    const v = open({ claudeConfigPath: claudeDir, dbPath: join(root, 'db', 'vault.db') });
    await v.initialize();

    expect(skillNames(v)).toEqual(['from-explicit-claude-path']);
  });
});
