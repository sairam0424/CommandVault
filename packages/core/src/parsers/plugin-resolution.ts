import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParseError } from '../types/index.js';
import { FileTooLargeError, readBoundedText, skippedTooLarge } from './bounded-read.js';

/** The fields of a marketplace listing that describe a plugin. */
export interface MarketplaceEntry {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string | { name: string; url?: string; email?: string };
  readonly keywords?: string[];
  readonly homepage?: string;
  readonly license?: string;
}

export interface ResolvedMarketplaceEntry {
  readonly entry: MarketplaceEntry;
  /** The marketplace.json the entry was read from. */
  readonly filePath: string;
}

/** `name@marketplace`, the key Claude Code records in `installed_plugins.json`. */
export interface PluginRegistryKey {
  readonly plugin: string;
  readonly marketplace: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Splits a registry key into plugin and marketplace. Both become path segments below the plugins
 * directory, so a key that could climb out of it is refused and yields null: the caller then
 * simply has no fallback for that plugin. A safe segment starts with a letter or digit and holds
 * no separator, so it can never be `.` or `..`.
 */
export function parseRegistryKey(key: string): PluginRegistryKey | null {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const plugin = key.slice(0, at);
  const marketplace = key.slice(at + 1);
  return SAFE_SEGMENT.test(plugin) && SAFE_SEGMENT.test(marketplace)
    ? { plugin, marketplace }
    : null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function modifiedTime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function newestSubdirectories(parent: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  const dirs = await Promise.all(
    names.map(async (name) => {
      const path = join(parent, name);
      return (await isDirectory(path)) ? { path, name, mtime: await modifiedTime(path) } : null;
    }),
  );
  return dirs
    .filter((dir): dir is { path: string; name: string; mtime: number } => dir !== null)
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1))
    .map((dir) => dir.path);
}

/**
 * Where a plugin whose recorded installPath no longer exists may really live: the cache directory
 * Claude Code lays out as `cache/<marketplace>/<plugin>/<version>`. The installed version comes
 * first, then every other cached version, newest first. Empty when the key is unusable.
 */
export async function findCachedInstallDirs(
  pluginsDir: string,
  key: string,
  installedVersion: string | undefined,
): Promise<string[]> {
  const parsed = parseRegistryKey(key);
  if (parsed === null) return [];
  const pluginCache = join(pluginsDir, 'cache', parsed.marketplace, parsed.plugin);
  const cached = await newestSubdirectories(pluginCache);
  const installed =
    typeof installedVersion === 'string' && SAFE_SEGMENT.test(installedVersion)
      ? join(pluginCache, installedVersion)
      : '';
  const rest = cached.filter((dir) => dir !== installed);
  return installed !== '' && (await isDirectory(installed)) ? [installed, ...rest] : rest;
}

export async function isMissingDirectory(path: string): Promise<boolean> {
  return !(await isDirectory(path));
}

function toAuthor(value: unknown): MarketplaceEntry['author'] {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || typeof value.name !== 'string') return undefined;
  return { name: value.name, url: optionalString(value.url), email: optionalString(value.email) };
}

function toMarketplaceEntry(record: Record<string, unknown>, name: string): MarketplaceEntry {
  return {
    name,
    description: optionalString(record.description),
    version: optionalString(record.version),
    author: toAuthor(record.author),
    keywords: Array.isArray(record.keywords)
      ? record.keywords.filter((k): k is string => typeof k === 'string')
      : undefined,
    homepage: optionalString(record.homepage),
    license: optionalString(record.license),
  };
}

/** A marketplace file that is simply absent is normal; one that cannot be used is worth a warning. */
function describeMarketplaceFailure(err: unknown, filePath: string): ParseError | null {
  if (err instanceof FileTooLargeError) return skippedTooLarge(err, 'marketplace file');
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
  const reason = err instanceof Error ? err.message : String(err);
  return {
    filePath,
    message: `Ignored marketplace file: ${reason}`,
    severity: 'warning',
    cause: err,
  };
}

/**
 * The listing for a plugin in its marketplace's `.claude-plugin/marketplace.json`, which is what
 * describes a plugin that ships no manifest of its own. Null when there is none; an oversized
 * marketplace file is reported in `warnings` rather than read.
 */
export async function readMarketplaceEntry(
  pluginsDir: string,
  key: string,
  warnings: ParseError[],
): Promise<ResolvedMarketplaceEntry | null> {
  const parsed = parseRegistryKey(key);
  if (parsed === null) return null;
  const filePath = join(
    pluginsDir,
    'marketplaces',
    parsed.marketplace,
    '.claude-plugin',
    'marketplace.json',
  );
  let listing: unknown;
  try {
    listing = JSON.parse(await readBoundedText(filePath));
  } catch (err) {
    const warning = describeMarketplaceFailure(err, filePath);
    if (warning !== null) warnings.push(warning);
    return null;
  }
  if (!isRecord(listing) || !Array.isArray(listing.plugins)) return null;
  const match = listing.plugins.find((p) => isRecord(p) && p.name === parsed.plugin);
  return isRecord(match) ? { entry: toMarketplaceEntry(match, parsed.plugin), filePath } : null;
}
