import { resolve } from 'node:path';
import chalk from 'chalk';
import {
  createVault,
  getParseSeverity,
  resolveClaudeDir,
  type ParseError,
  type Vault,
  type VaultEntry,
  type EntryType,
  type SearchTier,
} from '@commandvault/core';
import { loadConfig, type CliConfig } from './config.js';
import { createSpinner } from './ui/spinner.js';

export interface CliGlobalOptions {
  readonly claudePath?: string;
  readonly tier?: SearchTier;
  readonly json?: boolean;
  /** Absolute project directory to scan in addition to the Claude config; absent = none. */
  readonly project?: string;
}

export interface VaultOverrides {
  /** Keep the index somewhere other than the data directory, e.g. a throwaway file. */
  readonly dbPath?: string;
  /** A config.json the caller already loaded, so it is read (and its warnings printed) once. */
  readonly config?: CliConfig;
}

/** The Claude config directory a vault built from these options scans. */
export function claudeDirFor(options: CliGlobalOptions, config: CliConfig): string {
  return resolve(options.claudePath ?? config.claudeConfigPath ?? resolveClaudeDir());
}

/**
 * Builds a vault from the global options, falling back to config.json for what they leave unset.
 * Every command that opens a vault goes through here so none of them ignores the config file.
 */
export async function createConfiguredVault(
  options: CliGlobalOptions,
  enableWatcher: boolean,
  overrides: VaultOverrides = {},
): Promise<Vault> {
  const config = overrides.config ?? (await loadConfig());
  return createVault({
    claudeConfigPath: options.claudePath ?? config.claudeConfigPath,
    defaultSearchTier: options.tier ?? config.searchTier,
    projectRoot: options.project,
    enableWatcher,
    ...(overrides.dbPath === undefined ? {} : { dbPath: overrides.dbPath }),
  });
}

export async function withVault<T>(
  opts: CliGlobalOptions,
  fn: (vault: Vault) => Promise<T>,
): Promise<T> {
  const vault = await createVaultInstance(opts);
  try {
    return await fn(vault);
  } finally {
    await vault.dispose();
  }
}

export function jsonOutput(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export async function createVaultInstance(
  options: CliGlobalOptions,
  overrides: VaultOverrides = {},
) {
  // Before the spinner: a bad config.json fails here without printing "Initializing vault...".
  const vault = await createConfiguredVault(options, false, overrides);
  const spinner = options.json ? null : createSpinner('Initializing vault...').start();

  try {
    const stats = await vault.initialize();
    spinner?.succeed(`Vault loaded: ${stats.totalEntries} entries indexed`);
    return vault;
  } catch (error) {
    spinner?.fail('Failed to initialize vault');
    throw error;
  }
}

const MAX_PROBLEMS_LISTED = 10;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Prints parse problems to stderr: errors in red, warnings in yellow, then a count line. A warning
 * never reads as a failure. Prints nothing when there is nothing to report.
 */
export function printParseProblems(problems: readonly ParseError[]): void {
  if (problems.length === 0) {
    return;
  }
  const errors = problems.filter((problem) => getParseSeverity(problem) === 'error');
  const warnings = problems.filter((problem) => getParseSeverity(problem) === 'warning');
  const lines = [
    ...errors.map((problem) => chalk.red(`  ✗ ${problem.message}`)),
    ...warnings.map((problem) => chalk.yellow(`  ⚠ ${problem.message}`)),
  ];
  for (const line of lines.slice(0, MAX_PROBLEMS_LISTED)) {
    console.error(line);
  }
  if (lines.length > MAX_PROBLEMS_LISTED) {
    console.error(chalk.dim(`  ... and ${lines.length - MAX_PROBLEMS_LISTED} more`));
  }
  const summarise = errors.length > 0 ? chalk.red : chalk.yellow;
  console.error(
    summarise(`  ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}`),
  );
}

/** The first problem that is an error (a warning is never the headline), else the first problem. */
export function headlineProblem(problems: readonly ParseError[]): ParseError | undefined {
  return problems.find((problem) => getParseSeverity(problem) === 'error') ?? problems[0];
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
