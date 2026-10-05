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

  it.each([['null'], ['42'], ['"text"'], ['["searchTier","fuse"]']])(
    'returns empty config and warns when the file holds the JSON value %s, not an object',
    async (content) => {
      const configDir = join(tmpDir, '.commandvault');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), content);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { loadConfig } = await import('../config.js');
      const config = await loadConfig();

      expect(config).toEqual({});
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a JSON object'));
      expect(logSpy, 'warnings must not reach stdout').not.toHaveBeenCalled();
    },
  );

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

describe('resolveProjectRoot', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-project-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('turns the bare flag into the current directory', async () => {
    const { resolveProjectRoot } = await import('../config.js');
    expect(resolveProjectRoot(true)).toBe(process.cwd());
  });

  it('returns an existing directory as an absolute path', async () => {
    const { resolveProjectRoot } = await import('../config.js');
    expect(resolveProjectRoot(home)).toBe(home);
  });

  it('rejects a missing directory, with a hint about the bare form', async () => {
    const { resolveProjectRoot } = await import('../config.js');
    expect(() => resolveProjectRoot('list')).toThrow(
      expect.objectContaining({
        message: '--project "list" does not exist',
        exitCode: 2,
        hint: expect.stringContaining('--project=<dir>'),
      }),
    );
  });

  it('rejects an empty value and a file', async () => {
    const file = join(home, 'f.txt');
    await writeFile(file, 'x');
    const { resolveProjectRoot } = await import('../config.js');
    expect(() => resolveProjectRoot('')).toThrow(
      expect.objectContaining({ message: '--project must not be empty' }),
    );
    expect(() => resolveProjectRoot(file)).toThrow(
      expect.objectContaining({ message: `--project "${file}" is not a directory` }),
    );
  });
});

describe('globalOptionArgs', () => {
  it('forwards the four global options and nothing else', async () => {
    const { globalOptionArgs } = await import('../config.js');
    expect(
      globalOptionArgs({
        claudePath: '/c',
        tier: 'fuse',
        json: true,
        project: '/p',
        tui: false,
        anythingElse: 'x',
      }),
    ).toEqual(['--json', '--claude-path', '/c', '--tier', 'fuse', '--project', '/p']);
  });

  it('forwards nothing when no global option was given', async () => {
    const { globalOptionArgs } = await import('../config.js');
    expect(globalOptionArgs({})).toEqual([]);
    expect(globalOptionArgs({ json: false, tui: true })).toEqual([]);
  });
});

describe('parseConfigValue', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-configvalue-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it.each(['sqlite', 'minisearch', 'fuse'])('accepts searchTier %s', async (tier) => {
    const { parseConfigValue } = await import('../config.js');
    expect(parseConfigValue('searchTier', tier)).toBe(tier);
  });

  it('rejects a searchTier outside the list as a usage error', async () => {
    const { parseConfigValue } = await import('../config.js');
    expect(() => parseConfigValue('searchTier', 'bogus')).toThrow(
      expect.objectContaining({
        message: 'invalid searchTier "bogus" (expected sqlite, minisearch or fuse)',
        exitCode: 2,
      }),
    );
  });

  it('parses enableWatcher strictly', async () => {
    const { parseConfigValue } = await import('../config.js');
    expect(parseConfigValue('enableWatcher', 'true')).toBe(true);
    expect(parseConfigValue('enableWatcher', 'false')).toBe(false);
    for (const bad of ['yes', '1', 'TRUE', '']) {
      expect(() => parseConfigValue('enableWatcher', bad)).toThrow(
        expect.objectContaining({ exitCode: 2, message: expect.stringContaining('true or false') }),
      );
    }
  });

  it('keeps claudeConfigPath a string, expands ~, and warns (not fails) when it is missing', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parseConfigValue } = await import('../config.js');
    expect(parseConfigValue('claudeConfigPath', '123')).toBe('123');
    expect(parseConfigValue('claudeConfigPath', '~/nowhere')).toBe(join(home, 'nowhere'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('does not exist');

    warn.mockClear();
    expect(parseConfigValue('claudeConfigPath', home)).toBe(home);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects an empty claudeConfigPath', async () => {
    const { parseConfigValue } = await import('../config.js');
    expect(() => parseConfigValue('claudeConfigPath', ' ')).toThrow(
      expect.objectContaining({ message: 'claudeConfigPath must not be empty', exitCode: 2 }),
    );
  });

  it('accepts a JSON array of strings for projectPaths and nothing else', async () => {
    const { parseConfigValue } = await import('../config.js');
    expect(parseConfigValue('projectPaths', '["/a","/b"]')).toEqual(['/a', '/b']);
    expect(parseConfigValue('projectPaths', '[]')).toEqual([]);
    for (const bad of ['/a', '[1]', '{"a":1}', '["a",', '']) {
      expect(() => parseConfigValue('projectPaths', bad)).toThrow(
        expect.objectContaining({ exitCode: 2 }),
      );
    }
  });

  it('rejects an unknown key and lists the valid ones', async () => {
    const { parseConfigValue } = await import('../config.js');
    expect(() => parseConfigValue('nope', '1')).toThrow(
      expect.objectContaining({
        message:
          'unknown config key "nope" (valid keys: claudeConfigPath, searchTier, enableWatcher, projectPaths)',
        exitCode: 2,
      }),
    );
    expect(() => parseConfigValue('registries', '[]')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('vault registry') }),
    );
  });
});

describe('config document read and write', () => {
  let home: string;
  let path: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-configdoc-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, 'data'));
    path = join(home, 'data', 'config.json');
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function seed(content: string): Promise<void> {
    await mkdir(join(home, 'data'), { recursive: true });
    await writeFile(path, content);
  }

  it('reads a missing file as an empty document', async () => {
    const { readConfigDocument } = await import('../config.js');
    expect(await readConfigDocument()).toEqual({});
  });

  it('reads a valid object, including keys it does not manage', async () => {
    await seed('{"searchTier":"fuse","x":{"y":1}}');
    const { readConfigDocument } = await import('../config.js');
    expect(await readConfigDocument()).toEqual({ searchTier: 'fuse', x: { y: 1 } });
  });

  it.each([
    ['invalid JSON', '{"a":'],
    ['an empty file', ''],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"fuse"'],
  ])('refuses %s with the path in the message and exit code 1', async (_name, content) => {
    await seed(content);
    const { readConfigDocument } = await import('../config.js');
    await expect(readConfigDocument()).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 1,
      message: expect.stringContaining(path),
      hint: expect.stringContaining('vault init --reset'),
    });
  });

  it('refuses a config path that is a directory instead of treating it as empty', async () => {
    await mkdir(path, { recursive: true });
    const { readConfigDocument } = await import('../config.js');
    await expect(readConfigDocument()).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/cannot read config file .*EISDIR/),
    });
  });

  it.skipIf(process.platform === 'win32')(
    'creates the directory as 0700 and the file as 0600, with a trailing newline',
    async () => {
      const { writeConfigDocument } = await import('../config.js');
      await writeConfigDocument({ searchTier: 'fuse' });
      const { statSync, readFileSync } = await import('node:fs');
      expect(statSync(join(home, 'data')).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('{\n  "searchTier": "fuse"\n}\n');
    },
  );

  it.each([
    [{ searchTier: 'bogus' }, /invalid searchTier "bogus" in .*config\.json/],
    [{ enableWatcher: 'yes' }, /invalid enableWatcher .*\(expected true or false\)/],
    [{ claudeConfigPath: 5 }, /invalid claudeConfigPath .*\(expected a string\)/],
    [{ projectPaths: [1] }, /invalid projectPaths .*\(expected an array of strings\)/],
    [{ registries: {} }, /invalid registries .*\(expected an array\)/],
  ])('refuses to write %j and leaves the file alone', async (document, message) => {
    await seed('{"searchTier":"fuse"}');
    const { writeConfigDocument } = await import('../config.js');
    await expect(writeConfigDocument(document)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(message),
    });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path, 'utf8')).toBe('{"searchTier":"fuse"}');
  });

  it('writes keys it does not manage back unchanged', async () => {
    const { writeConfigDocument, readConfigDocument } = await import('../config.js');
    await writeConfigDocument({ searchTier: 'fuse', future: { a: [1, 2] } });
    expect(await readConfigDocument()).toEqual({ searchTier: 'fuse', future: { a: [1, 2] } });
  });

  describe('a write that fails part way', () => {
    afterEach(() => {
      vi.doUnmock('node:fs/promises');
    });

    /** Every file handle opened for writing stores half the data, then fails like a full disk. */
    async function importWithDiskFullOnWrite(): Promise<typeof import('../config.js')> {
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          writeFile: async (file: unknown, data: unknown, ...rest: unknown[]) => {
            const half = String(data).slice(0, Math.floor(String(data).length / 2));
            await (actual.writeFile as (...args: unknown[]) => Promise<void>)(file, half, ...rest);
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          },
          open: async (...args: Parameters<typeof actual.open>) => {
            const handle = await actual.open(...args);
            return new Proxy(handle, {
              get(target, prop) {
                if (prop !== 'writeFile') {
                  const member = Reflect.get(target, prop) as unknown;
                  return typeof member === 'function' ? member.bind(target) : member;
                }
                return async (data: unknown) => {
                  await target.writeFile(
                    String(data).slice(0, Math.floor(String(data).length / 2)),
                  );
                  throw Object.assign(new Error('ENOSPC: no space left on device'), {
                    code: 'ENOSPC',
                  });
                };
              },
            });
          },
        };
      });
      return import('../config.js');
    }

    it('leaves the existing config byte-identical and no temp file behind', async () => {
      const original = '{"searchTier":"fuse","claudeConfigPath":"/keep/me"}\n';
      await seed(original);
      const { writeConfigDocument } = await importWithDiskFullOnWrite();
      await expect(
        writeConfigDocument({
          searchTier: 'sqlite',
          claudeConfigPath: '/keep/me',
          extra: 'x'.repeat(200),
        }),
      ).rejects.toMatchObject({ code: 'ENOSPC' });
      const { readFileSync, readdirSync } = await import('node:fs');
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readdirSync(join(home, 'data'))).toEqual(['config.json']);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked config.json instead of replacing the link',
    async () => {
      const { mkdirSync, symlinkSync, lstatSync, readFileSync, writeFileSync } =
        await import('node:fs');
      const real = join(home, 'dotfiles', 'vault-config.json');
      mkdirSync(join(home, 'dotfiles'), { recursive: true });
      mkdirSync(join(home, 'data'), { recursive: true });
      writeFileSync(real, '{"searchTier":"fuse"}');
      symlinkSync(real, path);
      const { writeConfigDocument } = await import('../config.js');
      await writeConfigDocument({ searchTier: 'sqlite' });
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ searchTier: 'sqlite' });
    },
  );
});
