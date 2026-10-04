import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { resolveDataDir, type SearchTier } from '@commandvault/core';

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

const VALID_TIERS: ReadonlySet<string> = new Set(['fuse', 'minisearch', 'sqlite']);

export interface CliConfig {
  readonly claudeConfigPath?: string;
  readonly searchTier?: SearchTier;
  readonly enableWatcher?: boolean;
}

export async function loadConfig(): Promise<CliConfig> {
  const configPath = configFilePath();
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.log(chalk.yellow(`Warning: Could not read config file: ${configPath} (${code})`));
    }
    return {};
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(chalk.yellow(`Warning: Malformed JSON in config file: ${configPath}`));
    console.log(
      chalk.yellow(
        'Using default configuration. Fix the file or delete it to silence this warning.',
      ),
    );
    return {};
  }

  return {
    claudeConfigPath:
      typeof parsed.claudeConfigPath === 'string' && parsed.claudeConfigPath
        ? parsed.claudeConfigPath.startsWith('~/')
          ? join(homedir(), parsed.claudeConfigPath.slice(2))
          : parsed.claudeConfigPath
        : undefined,
    searchTier:
      typeof parsed.searchTier === 'string' && VALID_TIERS.has(parsed.searchTier)
        ? (parsed.searchTier as SearchTier)
        : undefined,
    enableWatcher: typeof parsed.enableWatcher === 'boolean' ? parsed.enableWatcher : undefined,
  };
}
