import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => _testHomeDir,
  };
});

let _testHomeDir: string;

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vault-loadconfig-test-'));
    _testHomeDir = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
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
      const { mkdir } = await import('node:fs/promises');
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
    const { mkdir } = await import('node:fs/promises');
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
    const { mkdir } = await import('node:fs/promises');
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
    const { mkdir } = await import('node:fs/promises');
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
    const { mkdir } = await import('node:fs/promises');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ searchTier: 'invalid-tier' }));

    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();
    expect(config.searchTier).toBeUndefined();
  });
});
