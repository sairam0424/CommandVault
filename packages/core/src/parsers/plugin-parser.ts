import { readFile } from 'node:fs/promises';
import { join, resolve, normalize } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateId, inferSource, extractTags } from './utils.js';

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
  readonly plugins: Record<
    string,
    Array<{
      scope: string;
      installPath: string;
      version: string;
      installedAt: string;
      lastUpdated: string;
      gitCommitSha?: string;
    }>
  >;
}

interface ResolvedManifest {
  readonly manifest: PluginManifest;
  readonly resolvedPath: string;
}

/**
 * Attempts to read and parse a JSON file at `filePath`.
 * Returns the parsed object on success, or `null` on any failure.
 */
async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Resolves a plugin manifest by trying paths in priority order:
 *   1. `.claude-plugin/plugin.json`  (primary — 34 of 47 plugins)
 *   2. `plugin.json`                 (legacy fallback)
 *   3. `package.json`                (npm package fallback)
 *   4. Synthesise minimal manifest from registry key
 */
async function resolveManifest(
  installPath: string,
  registryKey: string,
  installVersion: string,
): Promise<ResolvedManifest> {
  // 1. Primary: .claude-plugin/plugin.json
  const primaryPath = join(installPath, '.claude-plugin', 'plugin.json');
  const primary = await tryReadJson<PluginManifest>(primaryPath);
  if (primary !== null) {
    return { manifest: primary, resolvedPath: primaryPath };
  }

  // 2. Legacy fallback: plugin.json at root
  const legacyPath = join(installPath, 'plugin.json');
  const legacy = await tryReadJson<PluginManifest>(legacyPath);
  if (legacy !== null) {
    return { manifest: legacy, resolvedPath: legacyPath };
  }

  // 3. npm package fallback: package.json (extract compatible fields)
  const pkgPath = join(installPath, 'package.json');
  const pkg = await tryReadJson<Record<string, unknown>>(pkgPath);
  if (pkg !== null) {
    const manifest: PluginManifest = {
      name: typeof pkg.name === 'string' ? pkg.name : registryKey.split('@')[0],
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : installVersion,
      author:
        typeof pkg.author === 'string'
          ? pkg.author
          : typeof pkg.author === 'object' && pkg.author !== null
            ? (pkg.author as { name: string; url?: string; email?: string })
            : undefined,
      keywords: Array.isArray(pkg.keywords) ? (pkg.keywords as string[]) : undefined,
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
      license: typeof pkg.license === 'string' ? pkg.license : undefined,
    };
    return { manifest, resolvedPath: pkgPath };
  }

  // 4. Synthesise minimal manifest from registry key
  const syntheticName = registryKey.split('@')[0] || registryKey;
  const syntheticPath = join(installPath, 'plugin.json');
  const manifest: PluginManifest = {
    name: syntheticName,
    description: '',
    version: installVersion,
  };
  return { manifest, resolvedPath: syntheticPath };
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
    return {
      entries: [],
      errors: [{ filePath: registryPath, message: 'Plugin registry not found' }],
    };
  }

  const parsePromises = Object.entries(registry.plugins).map(async ([key, installations]) => {
    const install = installations[0];
    if (!install) return;

    // Path containment: block installPaths that escape the plugins directory
    const normalizedInstall = normalize(resolve(install.installPath));
    const normalizedPlugins = normalize(resolve(pluginsDir));
    if (!normalizedInstall.startsWith(normalizedPlugins)) {
      errors.push({
        filePath: install.installPath,
        message: `Blocked: installPath "${install.installPath}" is outside plugins directory`,
      });
      return;
    }

    try {
      const { manifest, resolvedPath } = await resolveManifest(
        install.installPath,
        key,
        install.version,
      );

      const name = manifest.name ?? key.split('@')[0];
      const description = manifest.description ?? '';
      const source = inferSource(name, install.installPath);
      const tags = extractTags(name, description, {
        keywords: manifest.keywords,
      });
      const lastModified = new Date(install.lastUpdated);

      const authorName =
        typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;

      const entry: VaultEntry = {
        id: generateId(resolvedPath),
        name,
        type: 'plugin',
        source,
        description,
        filePath: resolvedPath,
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
        filePath: install.installPath,
        message: `Failed to parse plugin: ${(err as Error).message}`,
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
