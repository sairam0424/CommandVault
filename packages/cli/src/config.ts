import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { resolveDataDir, type SearchTier } from '@commandvault/core';
import { invalidChoiceError, usageError } from './errors.js';

const CONFIG_FILE_NAME = 'config.json';
const DB_FILE_NAME = 'vault.db';
const BACKUP_DIR_NAME = 'backups';

/** Resolved when called, so COMMANDVAULT_HOME and HOME changes after import are honoured. */
export function configFilePath(): string {
  return join(resolveDataDir(), CONFIG_FILE_NAME);
}

export function dbFilePath(): string {
  return join(resolveDataDir(), DB_FILE_NAME);
}

export function backupDirPath(): string {
  return join(resolveDataDir(), BACKUP_DIR_NAME);
}

/** Every search tier the vault supports, in the order error messages list them. */
export const SEARCH_TIERS = [
  'sqlite',
  'minisearch',
  'fuse',
] as const satisfies readonly SearchTier[];

/**
 * Fails to compile when core adds a tier that is missing from {@link SEARCH_TIERS}
 * (core exports the `SearchTier` type only, not a runtime list).
 */
export type AssertAllTiersListed<
  Missing extends never = Exclude<SearchTier, (typeof SEARCH_TIERS)[number]>,
> = Missing;

export interface CliConfig {
  readonly claudeConfigPath?: string;
  readonly searchTier?: SearchTier;
  readonly enableWatcher?: boolean;
}

function isSearchTier(value: unknown): value is SearchTier {
  return typeof value === 'string' && (SEARCH_TIERS as readonly string[]).includes(value);
}

/** Validates a `--tier` value. */
export function parseTierOption(value: string): SearchTier {
  if (!isSearchTier(value)) {
    throw invalidChoiceError('--tier', value, SEARCH_TIERS);
  }
  return value;
}

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

/**
 * Resolves a `--claude-path` value (leading `~` expanded, made absolute) and checks that it is an
 * existing directory. Never creates it.
 */
export function resolveClaudePath(input: string): string {
  if (input.trim() === '') {
    // resolve('') is the current directory, which would silently index whatever the shell is in.
    throw usageError('--claude-path must not be empty');
  }
  const absolute = resolve(expandHome(input));
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' || code === 'ENOTDIR' ? 'does not exist' : `is unreadable (${code})`;
    throw usageError(`--claude-path "${input}" ${reason}`);
  }
  if (!isDirectory) {
    throw usageError(`--claude-path "${input}" is not a directory`);
  }
  return absolute;
}

/** Config warnings are diagnostics, so they go to stderr and never pollute `--json` output. */
function warn(message: string): void {
  console.error(chalk.yellow(message));
}

export async function loadConfig(): Promise<CliConfig> {
  const configPath = configFilePath();
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warn(`Warning: Could not read config file: ${configPath} (${code})`);
    }
    return {};
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    warn(`Warning: Malformed JSON in config file: ${configPath}`);
    warn('Using default configuration. Fix the file or delete it to silence this warning.');
    return {};
  }

  if (parsed.searchTier !== undefined && !isSearchTier(parsed.searchTier)) {
    throw invalidChoiceError('searchTier', parsed.searchTier, SEARCH_TIERS, configPath);
  }

  return {
    claudeConfigPath:
      typeof parsed.claudeConfigPath === 'string' && parsed.claudeConfigPath
        ? parsed.claudeConfigPath.startsWith('~/')
          ? join(homedir(), parsed.claudeConfigPath.slice(2))
          : parsed.claudeConfigPath
        : undefined,
    searchTier: parsed.searchTier,
    enableWatcher: typeof parsed.enableWatcher === 'boolean' ? parsed.enableWatcher : undefined,
  };
}
