import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parsePlugins } from '../parsers/plugin-parser.js';
import { skippedTooLarge, FileTooLargeError } from '../parsers/bounded-read.js';
import { MAX_PARSE_FILE_BYTES } from '../constants.js';

const MARKETPLACE = 'acme-market';
const PLUGIN = 'widget';
const KEY = `${PLUGIN}@${MARKETPLACE}`;

let pluginsDir: string;

function cacheDir(...parts: string[]): string {
  return join(pluginsDir, 'cache', MARKETPLACE, PLUGIN, ...parts);
}

async function writeManifest(dir: string, description: string): Promise<void> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, description }),
  );
}

async function writeMarketplace(
  plugins: readonly unknown[],
  marketplace: string = MARKETPLACE,
): Promise<string> {
  const dir = join(pluginsDir, 'marketplaces', marketplace, '.claude-plugin');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'marketplace.json');
  await writeFile(file, JSON.stringify({ name: marketplace, plugins }));
  return file;
}

async function writeRegistry(key: string, installPath: string, version = '1.0.0'): Promise<void> {
  const install = {
    scope: 'user',
    installPath,
    version,
    installedAt: '2025-06-15T10:00:00.000Z',
    lastUpdated: '2025-07-01T14:30:00.000Z',
  };
  await writeFile(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [key]: [install] } }),
  );
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'cv-plugin-resolution-'));
});

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true });
});

describe('plugin with a stale installPath', () => {
  it('is resolved from the cache directory of the installed version', async () => {
    await writeManifest(cacheDir('1.0.0'), 'From the versioned cache');
    await writeManifest(cacheDir('0.9.0'), 'Older and not installed');
    await writeRegistry(KEY, cacheDir('gone'), '1.0.0');

    const { entries, errors } = await parsePlugins(pluginsDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('From the versioned cache');
    expect(existsSync(entries[0].filePath)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('falls back to the newest cached version when the installed one is gone', async () => {
    await writeManifest(cacheDir('aaa111'), 'Old build');
    await writeManifest(cacheDir('bbb222'), 'New build');
    const old = new Date('2025-01-01T00:00:00Z');
    const recent = new Date('2025-06-01T00:00:00Z');
    await utimes(cacheDir('aaa111'), old, old);
    await utimes(cacheDir('bbb222'), recent, recent);
    await writeRegistry(KEY, cacheDir('gone'), '9.9.9');

    const { entries } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('New build');
  });

  it('still resolves from the cache when the registry entry records no version', async () => {
    await writeManifest(cacheDir('1.0.0'), 'Cached, version not recorded');
    await writeFile(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [KEY]: [{ installPath: cacheDir('gone') }] } }),
    );

    const { entries, errors } = await parsePlugins(pluginsDir);

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('Cached, version not recorded');
  });

  it('does not borrow a cached manifest when the recorded installPath exists without one', async () => {
    await mkdir(cacheDir('1.0.0'), { recursive: true });
    await writeManifest(cacheDir('2.0.0'), 'A different cached version');
    await writeRegistry(KEY, cacheDir('1.0.0'), '1.0.0');

    const { entries, errors } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('');
    expect(errors.map((e) => e.severity)).toEqual(['warning']);
  });

  it('never replaces a manifest found at the recorded installPath', async () => {
    await writeManifest(cacheDir('1.0.0'), 'Recorded install');
    await writeManifest(cacheDir('2.0.0'), 'Some other version');
    await writeRegistry(KEY, cacheDir('1.0.0'));

    const { entries } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('Recorded install');
  });
});

describe('plugin without a manifest', () => {
  it('takes its description and provenance from the marketplace entry', async () => {
    await mkdir(cacheDir('1.0.0'), { recursive: true });
    const marketplaceFile = await writeMarketplace([
      { name: 'other', description: 'Not this one' },
      {
        name: PLUGIN,
        description: 'Listed in the marketplace',
        version: '1.0.0',
        keywords: ['listed'],
      },
    ]);
    await writeRegistry(KEY, cacheDir('1.0.0'));

    const { entries, errors } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('Listed in the marketplace');
    expect(entries[0].filePath).toBe(marketplaceFile);
    expect(entries[0].metadata.descriptionSource).toBe('marketplace');
    expect(entries[0].tags).toContain('listed');
    expect(errors).toEqual([]);
  });

  it('prefers a real manifest over the marketplace entry', async () => {
    await writeManifest(cacheDir('1.0.0'), 'Shipped manifest');
    await writeMarketplace([{ name: PLUGIN, description: 'Marketplace blurb' }]);
    await writeRegistry(KEY, cacheDir('1.0.0'));

    const { entries } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('Shipped manifest');
    expect(entries[0].metadata.descriptionSource).toBeUndefined();
  });

  it('warns, but still lists the plugin, when nothing describes it', async () => {
    await mkdir(cacheDir('1.0.0'), { recursive: true });
    await writeRegistry(KEY, cacheDir('1.0.0'));

    const { entries, errors } = await parsePlugins(pluginsDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('');
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe('warning');
    expect(errors[0].message).toContain(KEY);
  });

  it('skips an oversized marketplace file with the size-limit warning', async () => {
    await mkdir(cacheDir('1.0.0'), { recursive: true });
    const marketplaceFile = await writeMarketplace([]);
    await writeFile(marketplaceFile, '');
    await truncate(marketplaceFile, MAX_PARSE_FILE_BYTES + 1);
    await writeRegistry(KEY, cacheDir('1.0.0'));

    const { entries, errors } = await parsePlugins(pluginsDir);

    const expected = skippedTooLarge(
      new FileTooLargeError(marketplaceFile, MAX_PARSE_FILE_BYTES + 1, MAX_PARSE_FILE_BYTES),
      'marketplace file',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('');
    const skip = errors.find((e) => e.filePath === marketplaceFile);
    expect(skip?.severity).toBe('warning');
    expect(skip?.message).toBe(expected.message);
    expect(skip?.message).toMatch(/^Skipped marketplace file: /);
  });

  it('keeps the plugin and warns when the marketplace file is malformed', async () => {
    await mkdir(cacheDir('1.0.0'), { recursive: true });
    const marketplaceFile = await writeMarketplace([]);
    await writeFile(marketplaceFile, '{ not json');
    await writeRegistry(KEY, cacheDir('1.0.0'));

    const { entries, errors } = await parsePlugins(pluginsDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('');
    const ignored = errors.find((e) => e.filePath === marketplaceFile);
    expect(ignored?.severity).toBe('warning');
    expect(ignored?.message).toMatch(/^Ignored marketplace file: /);
  });

  it('reports the installed version, not the one the marketplace has moved on to', async () => {
    await mkdir(cacheDir('1.0.0'), { recursive: true });
    await writeMarketplace([{ name: PLUGIN, description: 'Listed', version: '2.0.0' }]);
    await writeRegistry(KEY, cacheDir('1.0.0'), '1.0.0');

    const { entries } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('Listed');
    expect(entries[0].metadata.version).toBe('1.0.0');
    expect(JSON.parse(entries[0].content).version).toBe('1.0.0');
  });
});

describe('registry keys are never used to leave the plugins directory', () => {
  // Everything a lax key parser could be lured into reading is planted, so a leak shows up as a
  // description instead of an empty string.
  async function plantBait(): Promise<void> {
    const bait = (name: string): unknown => ({ name, description: 'Planted bait' });
    await writeMarketplace([bait('a/b'), bait('../p'), bait(PLUGIN)], 'a/b');
    await writeMarketplace([bait('a/b'), bait('../p')], 'acme');
    await writeManifest(join(pluginsDir, 'cache', 'acme', 'a', 'b', '1.0.0'), 'Planted bait');
    await writeManifest(join(pluginsDir, 'cache', 'acme', '..', 'p', '1.0.0'), 'Planted bait');
    await writeManifest(join(pluginsDir, 'cache', 'a', 'b', PLUGIN, '1.0.0'), 'Planted bait');
  }

  it.each(['a/b@acme', '../p@acme', `${PLUGIN}@a/b`, 'a@b@acme', 'a\\b@acme', '@acme', PLUGIN])(
    'gives "%s" no fallback at all',
    async (key) => {
      await plantBait();
      await writeRegistry(key, join(pluginsDir, 'cache', 'gone'));

      const { entries } = await parsePlugins(pluginsDir);

      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe('');
    },
  );

  it('does not follow an installed version that climbs out of the plugin cache', async () => {
    await writeManifest(join(pluginsDir, 'cache', MARKETPLACE), 'Planted bait');
    await writeRegistry(KEY, cacheDir('gone'), '..');

    const { entries } = await parsePlugins(pluginsDir);

    expect(entries[0].description).toBe('');
  });

  it('ignores a marketplace name that climbs out of the plugins directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cv-plugin-outside-'));
    try {
      await mkdir(join(outside, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(outside, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ plugins: [{ name: PLUGIN, description: 'Planted outside' }] }),
      );
      const climb = relative(join(pluginsDir, 'marketplaces'), outside);
      await mkdir(cacheDir('1.0.0'), { recursive: true });
      await writeRegistry(`${PLUGIN}@${climb}`, cacheDir('1.0.0'));

      const { entries } = await parsePlugins(pluginsDir);

      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe('');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
