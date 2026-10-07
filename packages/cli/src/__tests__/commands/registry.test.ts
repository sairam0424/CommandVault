import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import type { RegistryEntry, RegistrySearchOutcome } from '@commandvault/core';

// `add` validates with the real policy; `search` gets a manager whose answer each test scripts.
const core = vi.hoisted(() => ({ RegistryManager: vi.fn() }));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  RegistryManager: core.RegistryManager,
}));

const ENTRY: RegistryEntry = {
  name: 'x-tool',
  description: 'finds x',
  type: 'skill',
  url: 'https://registry.example/x',
  source: 'good',
};

function scriptedSearch(outcome: RegistrySearchOutcome): void {
  core.RegistryManager.mockImplementation(() => ({
    addRegistry: vi.fn(),
    search: vi.fn(async () => outcome),
  }));
}

describe('registry command', () => {
  let home: string;
  let configPath: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let previousLevel: typeof chalk.level;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-registry-cmd-test-'));
    configPath = join(home, 'data', 'config.json');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, 'data'));
    vi.resetModules();
    previousLevel = chalk.level;
    chalk.level = 1;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    chalk.level = previousLevel;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    core.RegistryManager.mockReset();
    await rm(home, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<void> {
    const { createRegistryCommand } = await import('../../commands/registry.js');
    await createRegistryCommand().exitOverride().parseAsync(args, { from: 'user' });
  }

  async function seed(content: string): Promise<void> {
    await mkdir(join(home, 'data'), { recursive: true });
    await writeFile(configPath, content);
  }

  const stderr = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

  it.each(['json', 'api'])('add accepts --type %s', async (type) => {
    await run('add', 'r', 'https://example.com/r.json', '--type', type);
    expect(JSON.parse(await readFile(configPath, 'utf8')).registries).toEqual([
      { name: 'r', url: 'https://example.com/r.json', type },
    ]);
  });

  it('add rejects an unknown --type as a usage error and writes nothing', async () => {
    await expect(
      run('add', 'r', 'https://example.com/r.json', '--type', 'bogus'),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: 'invalid --type "bogus" (expected json or api)',
    });
    expect(existsSync(configPath)).toBe(false);
  });

  it('add keeps the other settings in config.json', async () => {
    await seed(JSON.stringify({ searchTier: 'fuse' }));
    await run('add', 'r', 'https://example.com/r.json');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      searchTier: 'fuse',
      registries: [{ name: 'r', url: 'https://example.com/r.json', type: 'json' }],
    });
  });

  describe('add refuses, as a usage error, before anything is written', () => {
    const LONG_NAME = 'a'.repeat(65);
    const NAME_RULE = '(expected ^[a-z0-9][a-z0-9._-]{0,63}$)';

    it.each([
      ['../../x', `invalid registry name "../../x" ${NAME_RULE}`],
      ['Bad Name', `invalid registry name "Bad Name" ${NAME_RULE}`],
      [LONG_NAME, `invalid registry name "${LONG_NAME}" ${NAME_RULE}`],
      ['', `invalid registry name "" ${NAME_RULE}`],
    ])('the name %s', async (name, message) => {
      await expect(run('add', name, 'https://example.com/r.json')).rejects.toMatchObject({
        exitCode: 2,
        message,
      });
      expect(existsSync(configPath)).toBe(false);
    });

    it.each([
      ['notaurl', 'invalid URL "notaurl"'],
      ['http://example.com/r.json', 'Only HTTPS URLs are supported'],
      ['https://u:p@h/r.json', 'URL must not contain a username or password'],
      [
        'https://127.0.0.1/r.json',
        'Blocked: private/internal URL "127.0.0.1" resolves to 127.0.0.1; to allow it add the host to the allowPrivateHosts config key',
      ],
      [
        'https://localhost/r.json',
        'Blocked: private/internal URL "localhost" resolves to the loopback interface (RFC 6761); to allow it add the host to the allowPrivateHosts config key',
      ],
    ])('the URL %s', async (url, message) => {
      await expect(run('add', 'r', url)).rejects.toMatchObject({ exitCode: 2, message });
      expect(existsSync(configPath)).toBe(false);
    });

    it('accepts a loopback URL once config.json allows the host', async () => {
      await seed(JSON.stringify({ allowPrivateHosts: ['127.0.0.1'] }));
      await run('add', 'lo', 'https://127.0.0.1/r.json');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        allowPrivateHosts: ['127.0.0.1'],
        registries: [{ name: 'lo', url: 'https://127.0.0.1/r.json', type: 'json' }],
      });
    });

    it('a non-string allow-list entry is ignored, not trusted', async () => {
      await seed(JSON.stringify({ allowPrivateHosts: [127, null, 'other.test'] }));
      await expect(run('add', 'lo', 'https://127.0.0.1/r.json')).rejects.toMatchObject({
        exitCode: 2,
      });
    });
  });

  describe('search tells the user which registries failed', () => {
    const TWO = JSON.stringify({
      registries: [
        { name: 'good', url: 'https://good.example/r.json', type: 'json' },
        { name: 'down', url: 'https://down.example/r.json', type: 'json' },
      ],
    });

    it('a partial failure prints one warning on stderr and still succeeds', async () => {
      await seed(TWO);
      scriptedSearch({
        entries: [ENTRY],
        total: 1,
        page: 1,
        pageSize: 10,
        failures: [{ registry: 'down', message: 'no response headers within 15 s' }],
      });

      await run('search', 'x');

      expect(stderr()).toBe(chalk.yellow('  ⚠ registry "down": no response headers within 15 s'));
      expect(core.RegistryManager).toHaveBeenCalledWith({ allowPrivateHosts: [] });
    });

    it('every registry failing is an error carrying the single registry message', async () => {
      await seed(
        JSON.stringify({
          registries: [{ name: 'down', url: 'https://down.example/r.json', type: 'json' }],
          allowPrivateHosts: ['down.example'],
        }),
      );
      scriptedSearch({
        entries: [],
        total: 0,
        page: 1,
        pageSize: 10,
        failures: [{ registry: 'down', message: 'no response headers within 15 s' }],
      });

      await expect(run('search', 'x')).rejects.toMatchObject({
        exitCode: 1,
        message: 'registry "down": no response headers within 15 s',
      });
      expect(core.RegistryManager).toHaveBeenCalledWith({ allowPrivateHosts: ['down.example'] });
    });

    it('several registries all failing: each warning, then a count', async () => {
      await seed(TWO);
      scriptedSearch({
        entries: [],
        total: 0,
        page: 1,
        pageSize: 10,
        failures: [
          { registry: 'good', message: 'HTTP 503' },
          { registry: 'down', message: 'Connection to "down.example" failed (ECONNREFUSED)' },
        ],
      });

      await expect(run('search', 'x')).rejects.toMatchObject({
        exitCode: 1,
        message: 'all 2 registries failed',
      });
      expect(stderr().split('\n')).toHaveLength(2);
    });

    it('no failures: no stderr at all', async () => {
      await seed(TWO);
      scriptedSearch({ entries: [ENTRY], total: 1, page: 1, pageSize: 10, failures: [] });

      await run('search', 'x');

      expect(stderr()).toBe('');
    });
  });

  it.each([
    ['add', ['add', 'r', 'https://example.com/r.json']],
    ['remove', ['remove', 'r']],
    ['list', ['list']],
    ['search', ['search', 'q']],
  ])('%s on a malformed config.json fails and leaves it byte-identical', async (_name, args) => {
    await seed('{"searchTier": "fuse", oops');
    await expect(run(...args)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining(configPath),
    });
    expect(await readFile(configPath, 'utf8')).toBe('{"searchTier": "fuse", oops');
  });
});
