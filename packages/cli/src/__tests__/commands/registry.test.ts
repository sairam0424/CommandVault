import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('registry command', () => {
  let home: string;
  let configPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-registry-cmd-test-'));
    configPath = join(home, 'data', 'config.json');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, 'data'));
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
