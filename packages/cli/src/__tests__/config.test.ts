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

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig();

    expect(config).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed JSON'));
    expect(logSpy, 'warnings must not reach stdout').not.toHaveBeenCalled();
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

  it.each([['invalid-tier'], [5], [null]])(
    'rejects the invalid searchTier %j with a usage error',
    async (searchTier) => {
      const configDir = join(tmpDir, '.commandvault');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), JSON.stringify({ searchTier }));

      const { loadConfig } = await import('../config.js');
      const { CommandError, EXIT_USAGE_ERROR } = await import('../errors.js');
      const error = await loadConfig().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CommandError);
      expect((error as InstanceType<typeof CommandError>).exitCode).toBe(EXIT_USAGE_ERROR);
      expect((error as Error).message).toBe(
        `invalid searchTier "${searchTier}" in ${join(configDir, 'config.json')} (expected sqlite, minisearch or fuse)`,
      );
    },
  );

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

describe('parseTierOption', () => {
  it.each(['sqlite', 'minisearch', 'fuse'])('accepts %s', async (tier) => {
    const { parseTierOption } = await import('../config.js');
    expect(parseTierOption(tier)).toBe(tier);
  });

  it.each(['bogus', 'SQLITE', '', 'fuse '])('rejects %j with the expected list', async (tier) => {
    const { parseTierOption } = await import('../config.js');
    const { EXIT_USAGE_ERROR } = await import('../errors.js');
    expect(() => parseTierOption(tier)).toThrow(
      expect.objectContaining({
        message: `invalid --tier "${tier}" (expected sqlite, minisearch or fuse)`,
        exitCode: EXIT_USAGE_ERROR,
      }),
    );
  });
});

describe('resolveClaudePath', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-claudepath-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns an existing directory as an absolute path', async () => {
    const { resolveClaudePath } = await import('../config.js');
    expect(resolveClaudePath(home)).toBe(home);
  });

  it('expands a leading ~ against the home directory', async () => {
    await mkdir(join(home, '.claude'));
    const { resolveClaudePath } = await import('../config.js');
    expect(resolveClaudePath('~/.claude')).toBe(join(home, '.claude'));
    expect(resolveClaudePath('~')).toBe(home);
  });

  it.each([
    ['an empty', ''],
    ['a blank', '  '],
  ])('rejects %s value', async (_name, value) => {
    const { resolveClaudePath } = await import('../config.js');
    expect(() => resolveClaudePath(value)).toThrow(
      expect.objectContaining({ message: '--claude-path must not be empty', exitCode: 2 }),
    );
  });

  it('rejects a missing path without creating it', async () => {
    const { existsSync } = await import('node:fs');
    const { resolveClaudePath } = await import('../config.js');
    const missing = join(home, 'missing');
    expect(() => resolveClaudePath(missing)).toThrow(
      expect.objectContaining({
        message: `--claude-path "${missing}" does not exist`,
        exitCode: 2,
      }),
    );
    expect(existsSync(missing)).toBe(false);
  });

  it('rejects a file', async () => {
    const file = join(home, 'file.txt');
    await writeFile(file, 'x');
    const { resolveClaudePath } = await import('../config.js');
    expect(() => resolveClaudePath(file)).toThrow(
      expect.objectContaining({
        message: `--claude-path "${file}" is not a directory`,
        exitCode: 2,
      }),
    );
  });
});
