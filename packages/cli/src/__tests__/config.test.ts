import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vault-loadconfig-test-'));
    // The data directory and `~` are resolved when loadConfig runs, so point them at the temp dir.
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    vi.stubEnv('COMMANDVAULT_HOME', '');
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads a valid config file', async () => {
    const configDir = join(tmpDir, '.commandvault');
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({ searchTier: 'sqlite', enableWatcher: false }),
      { recursive: true } as any,
    ).catch(async () => {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({ searchTier: 'sqlite', enableWatcher: false }),
      );
    });

    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();
    expect(config.searchTier).toBe('sqlite');
    expect(config.enableWatcher).toBe(false);
  });

  it('returns empty config when file does not exist', async () => {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();
    expect(config).toEqual({});
  });

  it('returns empty config and warns on invalid JSON', async () => {
    const configDir = join(tmpDir, '.commandvault');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), '{not valid json!!!');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();

    expect(config).toEqual({});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed JSON'));
    consoleSpy.mockRestore();
  });

  it('ignores unknown config keys', async () => {
    const configDir = join(tmpDir, '.commandvault');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({ unknownKey: 'value', searchTier: 'fuse' }),
    );

    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();
    expect(config.searchTier).toBe('fuse');
    expect((config as Record<string, unknown>)['unknownKey']).toBeUndefined();
  });

  it('expands ~ in claudeConfigPath', async () => {
    const configDir = join(tmpDir, '.commandvault');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'config.json'),
      JSON.stringify({ claudeConfigPath: '~/.claude' }),
    );

    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();
    expect(config.claudeConfigPath).toBe(join(tmpDir, '.claude'));
  });

  it('rejects invalid searchTier values', async () => {
    const configDir = join(tmpDir, '.commandvault');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ searchTier: 'invalid-tier' }));

    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();
    expect(config.searchTier).toBeUndefined();
  });
  it('reads config.json from COMMANDVAULT_HOME instead of <HOME>/.commandvault', async () => {
    const dataDir = join(tmpDir, 'elsewhere');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ searchTier: 'sqlite' }));
    await mkdir(join(tmpDir, '.commandvault'), { recursive: true });
    await writeFile(
      join(tmpDir, '.commandvault', 'config.json'),
      JSON.stringify({ searchTier: 'fuse' }),
    );
    vi.stubEnv('COMMANDVAULT_HOME', dataDir);

    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();

    expect(config.searchTier).toBe('sqlite');
  });

  it('resolves the data directory on every call, not when the module is imported', async () => {
    const first = join(tmpDir, 'first');
    const second = join(tmpDir, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, 'config.json'), JSON.stringify({ searchTier: 'fuse' }));
    await writeFile(join(second, 'config.json'), JSON.stringify({ searchTier: 'sqlite' }));

    const { loadConfig, configFilePath } = await import('../config.js');
    vi.stubEnv('COMMANDVAULT_HOME', first);
    expect((await loadConfig()).searchTier).toBe('fuse');
    expect(configFilePath()).toBe(join(first, 'config.json'));

    vi.stubEnv('COMMANDVAULT_HOME', second);
    expect((await loadConfig()).searchTier).toBe('sqlite');
    expect(configFilePath()).toBe(join(second, 'config.json'));
  });
});
