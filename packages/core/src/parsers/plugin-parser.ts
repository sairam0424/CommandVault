import { join, resolve, normalize } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateStableId, inferSource, extractTags } from './utils.js';
import { FileTooLargeError, readBoundedText, skippedTooLarge } from './bounded-read.js';
import {
  findCachedInstallDirs,
  isMissingDirectory,
  readMarketplaceEntry,
} from './plugin-resolution.js';

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
      version?: string;
      installedAt: string;
      lastUpdated: string;
      gitCommitSha?: string;
    }>
  >;
}

interface ResolvedManifest {
  readonly manifest: PluginManifest;
  readonly resolvedPath: string;
  /** Set when the description was not the plugin's own but its marketplace listing's. */
  readonly descriptionSource?: 'marketplace';
}

/**
 * Attempts to read and parse a JSON file at `filePath`.
 * Returns the parsed object on success, or `null` on any failure. A missing or malformed candidate
 * is expected (the caller tries the next location); a file over the read limit is reported in
 * `warnings`, because skipping it is a decision the user would otherwise never see.
 */
async function tryReadJson<T>(filePath: string, warnings: ParseError[]): Promise<T | null> {
  try {
    const raw = await readBoundedText(filePath);
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof FileTooLargeError) warnings.push(skippedTooLarge(err, 'plugin manifest'));
    return null;
  }
}

/**
 * Reads the manifest inside one install directory, trying in priority order:
 *   1. `.claude-plugin/plugin.json`  (primary)
 *   2. `plugin.json`                 (legacy fallback)
 *   3. `package.json`                (npm package fallback, compatible fields only)
 */
async function readManifestFromDir(
  dir: string,
  registryKey: string,
  installVersion: string | undefined,
  warnings: ParseError[],
): Promise<ResolvedManifest | null> {
  const primaryPath = join(dir, '.claude-plugin', 'plugin.json');
  const primary = await tryReadJson<PluginManifest>(primaryPath, warnings);
  if (primary !== null) return { manifest: primary, resolvedPath: primaryPath };

  const legacyPath = join(dir, 'plugin.json');
  const legacy = await tryReadJson<PluginManifest>(legacyPath, warnings);
  if (legacy !== null) return { manifest: legacy, resolvedPath: legacyPath };

  const pkgPath = join(dir, 'package.json');
  const pkg = await tryReadJson<Record<string, unknown>>(pkgPath, warnings);
  if (pkg === null) return null;
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

/** The directories to look for a manifest in: the recorded one, plus the cache when it is gone. */
async function candidateInstallDirs(
  pluginsDir: string,
  installPath: string,
  registryKey: string,
  installVersion: string | undefined,
): Promise<string[]> {
  if (!(await isMissingDirectory(installPath))) return [installPath];
  const cached = await findCachedInstallDirs(pluginsDir, registryKey, installVersion);
  return [installPath, ...cached];
}

/**
 * Resolves a plugin manifest, most authoritative source first:
 *   1. a manifest in the recorded install directory, or in the cache when that directory is stale
 *   2. the plugin's listing in its marketplace, for a plugin that ships no manifest
 *   3. a minimal manifest built from the registry key, with a warning that nothing describes it
 */
async function resolveManifest(
  pluginsDir: string,
  installPath: string,
  registryKey: string,
  installVersion: string | undefined,
  warnings: ParseError[],
): Promise<ResolvedManifest> {
  const dirs = await candidateInstallDirs(pluginsDir, installPath, registryKey, installVersion);
  for (const dir of dirs) {
    const found = await readManifestFromDir(dir, registryKey, installVersion, warnings);
    if (found !== null) return found;
  }

  const listed = await readMarketplaceEntry(pluginsDir, registryKey, warnings);
  if (listed !== null) {
    // The listing may have moved on to a newer release; this install is still installVersion.
    return {
      manifest: { ...listed.entry, version: installVersion },
      resolvedPath: listed.filePath,
      descriptionSource: 'marketplace',
    };
  }

  warnings.push({
    filePath: installPath,
    message: `Plugin "${registryKey}" has no manifest and no marketplace listing, so it has no description`,
    severity: 'warning',
  });
  const name = registryKey.split('@')[0] || registryKey;
  const manifest: PluginManifest = { name, description: '', version: installVersion };
  return { manifest, resolvedPath: join(installPath, 'plugin.json') };
}

/** Epoch, not "now": an unknown date must stay stable across scans so it never looks modified. */
const UNKNOWN_DATE = new Date(0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toValidDate(value: unknown): Date {
  if (typeof value !== 'string' && typeof value !== 'number') return UNKNOWN_DATE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? UNKNOWN_DATE : date;
}

type Installation = InstalledPlugins['plugins'][string][number];

function firstInstallation(key: string, installations: unknown): Installation {
  if (!Array.isArray(installations)) {
    throw new Error(`registry entry "${key}" is not an array of installations`);
  }
  const install: unknown = installations[0];
  if (!isRecord(install) || typeof install.installPath !== 'string') {
    throw new Error(`registry entry "${key}" has no installation with a string installPath`);
  }
  return install as unknown as Installation;
}

async function buildPluginEntry(
  pluginsDir: string,
  key: string,
  install: Installation,
  warnings: ParseError[],
): Promise<VaultEntry> {
  const { manifest, resolvedPath, descriptionSource } = await resolveManifest(
    pluginsDir,
    install.installPath,
    key,
    install.version,
    warnings,
  );

  const name = manifest.name ?? key.split('@')[0];
  const description = manifest.description ?? '';
  const source = inferSource(name, install.installPath);
  const tags = extractTags(name, description, {
    keywords: manifest.keywords,
  });
  const authorName = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;

  return {
    id: generateStableId('plugin', name, source),
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
      ...(descriptionSource ? { descriptionSource } : {}),
    },
    content: JSON.stringify(manifest, null, 2),
    lastModified: toValidDate(install.lastUpdated),
    favorite: false,
    usageCount: 0,
  };
}

export async function parsePlugins(pluginsDir: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  const registryPath = join(pluginsDir, 'installed_plugins.json');
  let registry: unknown;
  try {
    registry = JSON.parse(await readBoundedText(registryPath));
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      return { entries: [], errors: [skippedTooLarge(err, 'plugin registry')] };
    }
    return {
      entries: [],
      errors: [{ filePath: registryPath, message: 'Plugin registry not found', severity: 'error' }],
    };
  }

  if (!isRecord(registry) || !isRecord(registry.plugins)) {
    return {
      entries: [],
      errors: [
        {
          filePath: registryPath,
          message: 'Plugin registry has no "plugins" object',
          severity: 'error',
        },
      ],
    };
  }

  const parsePromises = Object.entries(registry.plugins).map(async ([key, installations]) => {
    // One malformed registry entry must cost only that plugin, never the whole registry.
    let installPath = registryPath;
    try {
      if (Array.isArray(installations) && installations.length === 0) return;
      const install = firstInstallation(key, installations);
      installPath = install.installPath;

      // Path containment: block installPaths that escape the plugins directory
      const normalizedInstall = normalize(resolve(install.installPath));
      const normalizedPlugins = normalize(resolve(pluginsDir));
      if (!normalizedInstall.startsWith(normalizedPlugins)) {
        errors.push({
          filePath: install.installPath,
          message: `Blocked: installPath "${install.installPath}" is outside plugins directory`,
          severity: 'error',
        });
        return;
      }

      entries.push(await buildPluginEntry(pluginsDir, key, install, errors));
    } catch (err) {
      errors.push({
        filePath: installPath,
        message: `Failed to parse plugin "${key}": ${(err as Error).message}`,
        severity: 'error',
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
