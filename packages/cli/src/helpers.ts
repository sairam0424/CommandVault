import chalk from 'chalk';
import ora from 'ora';
import { createVault, type VaultEntry, type EntryType, type SearchTier } from '@commandvault/core';
import { loadConfig } from './config.js';

export interface CliGlobalOptions {
  readonly claudePath?: string;
  readonly tier?: SearchTier;
  readonly json?: boolean;
}

export async function createVaultInstance(options: CliGlobalOptions) {
  const config = await loadConfig();
  const spinner = options.json ? null : ora('Initializing vault...').start();

  try {
    const vault = createVault({
      claudeConfigPath: options.claudePath ?? config.claudeConfigPath,
      defaultSearchTier: options.tier ?? config.searchTier,
      enableWatcher: false,
    });

    const stats = await vault.initialize();
    spinner?.succeed(`Vault loaded: ${stats.totalEntries} entries indexed`);
    return vault;
  } catch (error) {
    spinner?.fail('Failed to initialize vault');
    throw error;
  }
}

const TYPE_EMOJIS: Readonly<Record<EntryType, string>> = {
  skill: '\u{1F9E0}',
  agent: '\u{1F916}',
  command: '\u{26A1}',
  plugin: '\u{1F50C}',
  rule: '\u{1F4CF}',
  hook: '\u{1FA9D}',
};

export function typeEmoji(type: EntryType): string {
  return TYPE_EMOJIS[type] ?? '?';
}

const TYPE_COLORS: Readonly<Record<EntryType, (text: string) => string>> = {
  skill: chalk.cyan,
  agent: chalk.blue,
  command: chalk.yellow,
  plugin: chalk.green,
  rule: chalk.magenta,
  hook: chalk.red,
};

export function typeColor(type: EntryType): (text: string) => string {
  return TYPE_COLORS[type] ?? ((t: string) => t);
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) {
    return str;
  }
  return `${str.slice(0, len - 1)}…`;
}

export function formatDate(date: Date): string {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    return 'just now';
  }

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  if (diffMs < MIN) {
    return 'just now';
  }
  if (diffMs < HOUR) {
    const mins = Math.floor(diffMs / MIN);
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  if (diffMs < DAY) {
    const hours = Math.floor(diffMs / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (diffMs < WEEK) {
    const days = Math.floor(diffMs / DAY);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  if (diffMs < MONTH) {
    const weeks = Math.floor(diffMs / WEEK);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  if (diffMs < YEAR) {
    const months = Math.floor(diffMs / MONTH);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }

  const years = Math.floor(diffMs / YEAR);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
