import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlugins } from '../parsers/plugin-parser.js';

/**
 * An installPath is contained by the relative path from the plugins directory, not by a string
 * prefix: `plugins-evil/x` starts with `plugins` and used to pass.
 */

let tempDir: string;
let pluginsDir: string;

async function installPlugin(dir: string, name: string): Promise<string> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: `${name} plugin` }),
  );
  return dir;
}

function installation(installPath: string): Record<string, string> {
  return { scope: 'user', installPath, version: '1.0.0', installedAt: '', lastUpdated: '' };
}

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-plugin-containment-')));
  pluginsDir = join(tempDir, 'plugins');
  await mkdir(pluginsDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('parsePlugins installPath containment', () => {
  it('blocks a sibling directory that shares the plugins directory as a prefix', async () => {
    const evil = await installPlugin(join(`${pluginsDir}-evil`, 'x'), 'evil');
    const inner = await installPlugin(join(pluginsDir, 'x'), 'inner');
    await installPlugin(pluginsDir, 'self');
    await writeFile(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'evil@market': [installation(evil)],
          'inner@market': [installation(inner)],
          'self@market': [installation(pluginsDir)],
        },
      }),
    );

    const result = await parsePlugins(pluginsDir);

    expect(result.entries.map((e) => e.name).sort()).toEqual(['inner', 'self']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(evil);
    expect(result.errors[0].message).toMatch(
      /^Blocked: installPath .* is outside plugins directory/,
    );
  });

  it('blocks an installPath that climbs out with ..', async () => {
    const climbing = join(pluginsDir, '..', 'elsewhere');
    await installPlugin(climbing, 'elsewhere');
    await writeFile(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'elsewhere@market': [installation(climbing)] } }),
    );

    const result = await parsePlugins(pluginsDir);

    expect(result.entries).toEqual([]);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^Blocked: installPath/),
    ]);
  });
});
