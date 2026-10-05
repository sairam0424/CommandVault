import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

describe('config command', () => {
  let home: string;
  let configPath: string;
  let out: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-config-cmd-test-'));
    configPath = join(home, 'data', 'config.json');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, 'data'));
    vi.resetModules();
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<void> {
    const { createConfigCommand } = await import('../../commands/config.js');
    const command: Command = createConfigCommand().exitOverride();
    await command.parseAsync(args, { from: 'user' });
  }

  async function seed(content: string): Promise<void> {
    await mkdir(join(home, 'data'), { recursive: true });
    await writeFile(configPath, content);
  }

  describe('get', () => {
    it('prints the full config, or one key', async () => {
      await seed(JSON.stringify({ searchTier: 'fuse', enableWatcher: true }));
      await run('get');
      expect(JSON.parse(out[0] ?? '')).toEqual({ searchTier: 'fuse', enableWatcher: true });
      out.length = 0;
      await run('get', 'searchTier');
      expect(out).toEqual(['fuse']);
    });

    it('prints {} when there is no config file yet', async () => {
      await run('get');
      expect(out).toEqual(['{}']);
    });

    it('fails on a malformed file instead of pretending it is empty', async () => {
      await seed('{bad');
      await expect(run('get')).rejects.toMatchObject({ exitCode: 1 });
      expect(out).toEqual([]);
    });
  });

  describe('set', () => {
    it('writes a validated value and reports it', async () => {
      await run('set', 'searchTier', 'fuse');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ searchTier: 'fuse' });
      expect(out[0]).toContain('searchTier');
      expect(out[0]).toContain('"fuse"');
    });

    it('keeps the other keys', async () => {
      await seed(JSON.stringify({ searchTier: 'fuse', extra: [1] }));
      await run('set', 'enableWatcher', 'false');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        searchTier: 'fuse',
        extra: [1],
        enableWatcher: false,
      });
    });

    it('rejects an invalid value before touching the file', async () => {
      await seed('{"searchTier":"fuse"}');
      await expect(run('set', 'searchTier', 'bogus')).rejects.toMatchObject({ exitCode: 2 });
      expect(await readFile(configPath, 'utf8')).toBe('{"searchTier":"fuse"}');
      expect(out).toEqual([]);
    });

    it('checks the value first, then refuses a malformed file without touching it', async () => {
      await seed('{bad');
      await expect(run('set', 'searchTier', 'bogus')).rejects.toMatchObject({ exitCode: 2 });
      await expect(run('set', 'searchTier', 'fuse')).rejects.toMatchObject({ exitCode: 1 });
      expect(await readFile(configPath, 'utf8')).toBe('{bad');
    });
  });
});
