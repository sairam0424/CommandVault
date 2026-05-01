import { readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateId, getLastModified, inferSource, extractTags } from './utils.js';

interface PluginManifest {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string | { name: string; url?: string; email?: string };
  readonly keywords?: string[];
  readonly skills?: string[];
  readonly homepage?: string;
  readonly license?: string;
}

interface InstalledPlugins {
  readonly version: number;
  readonly plugins: Record<string, Array<{
    scope: string;
    installPath: string;
    version: string;
    installedAt: string;
    lastUpdated: string;
    gitCommitSha?: string;
  }>>;
}

export async function parsePlugins(pluginsDir: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  const registryPath = join(pluginsDir, 'installed_plugins.json');
  let registry: InstalledPlugins;
  try {
    const raw = await readFile(registryPath, 'utf-8');
    registry = JSON.parse(raw);
  } catch {
    return { entries: [], errors: [{ filePath: registryPath, message: 'Plugin registry not found' }] };
  }

  const parsePromises = Object.entries(registry.plugins).map(async ([key, installations]) => {
    const install = installations[0];
    if (!install) return;

    const manifestPath = join(install.installPath, 'plugin.json');
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest: PluginManifest = JSON.parse(raw);
      const name = manifest.name ?? key.split('@')[0];
      const description = manifest.description ?? '';
      const source = inferSource(name, install.installPath);
      const tags = extractTags(name, description, {
        keywords: manifest.keywords,
      });
      const lastModified = new Date(install.lastUpdated);

      const authorName = typeof manifest.author === 'string'
        ? manifest.author
        : manifest.author?.name;

      const entry: VaultEntry = {
        id: generateId(manifestPath),
        name,
        type: 'plugin',
        source,
        description,
        filePath: manifestPath,
        tags,
        metadata: {
          version: manifest.version ?? install.version,
          author: authorName,
          homepage: manifest.homepage,
          license: manifest.license,
          scope: install.scope,
          installedAt: install.installedAt,
          registryKey: key,
          skills: manifest.skills,
          gitCommitSha: install.gitCommitSha,
        },
        content: JSON.stringify(manifest, null, 2),
        lastModified,
        favorite: false,
        usageCount: 0,
      };
      entries.push(entry);
    } catch (err) {
      errors.push({
        filePath: manifestPath,
        message: `Failed to parse plugin: ${(err as Error).message}`,
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
