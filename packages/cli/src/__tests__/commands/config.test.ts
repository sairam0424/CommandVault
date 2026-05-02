import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_MODULE = '../../commands/config.js';

async function loadConfigModule(configPath: string) {
  vi.doUnmock(CONFIG_MODULE);

  const mod = await import(CONFIG_MODULE);

  const originalReadConfig = mod.readConfig;
  const originalWriteConfig = mod.writeConfig;

  return {
    readConfig: async () => {
      try {
        const raw = await readFile(configPath, 'utf-8');
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    writeConfig: async (config: Record<string, unknown>) => {
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    },
    parseValue: mod.parseValue as (raw: string) => unknown,
    _originalReadConfig: originalReadConfig,
    _originalWriteConfig: originalWriteConfig,
  };
}

describe('config command', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vault-config-test-'));
    configPath = join(tmpDir, 'config.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('config get', () => {
    it('reads full config from file', async () => {
      const testConfig = { searchTier: 'fuse', enableWatcher: true };
      await writeFile(configPath, JSON.stringify(testConfig));
      const { readConfig } = await loadConfigModule(configPath);

      const config = await readConfig();
      expect(config).toEqual(testConfig);
    });

    it('reads a specific key', async () => {
      const testConfig = { searchTier: 'sqlite', claudeConfigPath: '/custom/path' };
      await writeFile(configPath, JSON.stringify(testConfig));
      const { readConfig } = await loadConfigModule(configPath);

      const config = await readConfig();
      expect(config['searchTier']).toBe('sqlite');
    });

    it('returns empty object when config file does not exist', async () => {
      const { readConfig } = await loadConfigModule(join(tmpDir, 'nonexistent.json'));

      const config = await readConfig();
      expect(config).toEqual({});
    });
  });

  describe('config set', () => {
    it('writes a key-value pair to the config', async () => {
      const { readConfig, writeConfig } = await loadConfigModule(configPath);

      await writeConfig({ searchTier: 'fuse' });
      const config = await readConfig();
      expect(config['searchTier']).toBe('fuse');
    });

    it('preserves existing keys when setting a new one', async () => {
      await writeFile(configPath, JSON.stringify({ searchTier: 'fuse' }));
      const { readConfig, writeConfig } = await loadConfigModule(configPath);

      const existing = await readConfig();
      const updated = { ...existing, enableWatcher: false };
      await writeConfig(updated);

      const result = await readConfig();
      expect(result['searchTier']).toBe('fuse');
      expect(result['enableWatcher']).toBe(false);
    });
  });

  describe('parseValue', () => {
    it('parses "true" as boolean true', async () => {
      const { parseValue } = await loadConfigModule(configPath);
      expect(parseValue('true')).toBe(true);
    });

    it('parses "false" as boolean false', async () => {
      const { parseValue } = await loadConfigModule(configPath);
      expect(parseValue('false')).toBe(false);
    });

    it('parses numeric strings as numbers', async () => {
      const { parseValue } = await loadConfigModule(configPath);
      expect(parseValue('42')).toBe(42);
      expect(parseValue('3.14')).toBe(3.14);
      expect(parseValue('0')).toBe(0);
    });

    it('keeps non-numeric, non-boolean strings as-is', async () => {
      const { parseValue } = await loadConfigModule(configPath);
      expect(parseValue('hello')).toBe('hello');
      expect(parseValue('/some/path')).toBe('/some/path');
    });
  });
});
