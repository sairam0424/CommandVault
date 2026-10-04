import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlugins } from '../parsers/plugin-parser.js';

let pluginsDir: string;

async function writeRegistry(registry: unknown): Promise<void> {
  await writeFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify(registry), 'utf-8');
}

async function makeInstall(dirName: string, manifestName: string): Promise<string> {
  const installPath = join(pluginsDir, 'cache', dirName);
  await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(installPath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: manifestName, description: 'fixture plugin' }),
    'utf-8',
  );
  return installPath;
}

function installation(installPath: string, overrides: Record<string, unknown> = {}) {
  return {
    scope: 'user',
    installPath,
    version: '1.0.0',
    installedAt: '2025-06-15T10:00:00.000Z',
    lastUpdated: '2025-07-01T14:30:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'cv-plugin-robustness-'));
});

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true });
});

describe('parsePlugins: malformed registry entries are isolated', () => {
  it('reports null, string and null-installation registry values and still parses the good plugin', async () => {
    const goodPath = await makeInstall('good', 'good-plugin');
    await writeRegistry({
      version: 1,
      plugins: {
        'null-entry@m': null,
        'string-entry@m': 'garbage',
        'null-install@m': [null],
        'good@m': [installation(goodPath)],
      },
    });

    const result = await parsePlugins(pluginsDir);

    expect(result.entries.map((e) => e.name)).toEqual(['good-plugin']);
    expect(result.errors).toHaveLength(3);
  });

  it('reports an installation whose installPath is not a string', async () => {
    const goodPath = await makeInstall('good', 'good-plugin');
    await writeRegistry({
      version: 1,
      plugins: {
        'bad-path@m': [installation(5 as unknown as string)],
        'good@m': [installation(goodPath)],
      },
    });

    const result = await parsePlugins(pluginsDir);

    expect(result.entries.map((e) => e.name)).toEqual(['good-plugin']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('bad-path@m');
  });

  it.each([
    ['a null registry', null],
    ['a registry without a plugins key', { version: 1 }],
    ['a registry whose plugins value is an array', { version: 1, plugins: [] }],
  ])('returns a ParseError for %s instead of rejecting', async (_label, registry) => {
    await writeRegistry(registry);

    const result = await parsePlugins(pluginsDir);

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('gives an installation with no lastUpdated a valid, stable lastModified', async () => {
    const goodPath = await makeInstall('good', 'good-plugin');
    await writeRegistry({
      version: 1,
      plugins: { 'good@m': [installation(goodPath, { lastUpdated: undefined })] },
    });

    const result = await parsePlugins(pluginsDir);

    expect(result.entries).toHaveLength(1);
    expect(Number.isNaN(result.entries[0].lastModified.getTime())).toBe(false);
  });
});
