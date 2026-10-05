import { createRequire } from 'node:module';
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  DatabaseOpenError,
  getParseSeverity,
  resolveDataDir,
  type ParseError,
} from '@commandvault/core';
import { configFilePath, dbFilePath, loadConfig, type CliConfig } from '../config.js';
import { CommandError } from '../errors.js';
import {
  claudeDirFor,
  createConfiguredVault,
  jsonOutput,
  type CliGlobalOptions,
} from '../helpers.js';
import { createSpinner } from '../ui/spinner.js';

type CheckStatus = 'pass' | 'info' | 'warn' | 'fail';

interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

interface VaultInspection {
  readonly checks: readonly Check[];
  readonly errors: readonly ParseError[];
}

const MAX_ERRORS_LISTED = 10;
const TEMP_DB_PREFIX = 'vault-doctor-';
const CORRUPT_BACKUP = /^vault\.db\.corrupt\..+\.bak$/;
const ENGINES_FLOOR = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

const STATUS_ICONS: Readonly<Record<CheckStatus, string>> = {
  pass: chalk.green('✓'),
  info: chalk.dim('○'),
  warn: chalk.yellow('⚠'),
  fail: chalk.red('✗'),
};

const check = (name: string, status: CheckStatus, detail: string): Check => ({
  name,
  status,
  detail,
});

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

type PathKind = 'directory' | 'file' | 'missing' | 'unreadable';

/** What is at `path`. Never throws: a path that cannot be examined is 'unreadable'. */
async function kindOf(path: string): Promise<PathKind> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

const PROBLEM_BY_KIND: Readonly<Record<Exclude<PathKind, 'directory'>, string>> = {
  file: 'is not a directory',
  missing: 'not found',
  unreadable: 'cannot be read',
};

/** The lowest Node version the CLI supports, read from its own package.json `engines.node`. */
function nodeRange(): string {
  const require = createRequire(import.meta.url);
  const manifest = require('../../package.json') as { engines?: { node?: string } };
  return manifest.engines?.node ?? '';
}

function atLeast(running: readonly number[], floor: readonly number[]): boolean {
  for (let index = 0; index < floor.length; index += 1) {
    if (running[index] !== floor[index]) {
      return (running[index] ?? 0) > (floor[index] ?? 0);
    }
  }
  return true;
}

export function checkNodeVersion(
  running: string = process.versions.node,
  range: string = nodeRange(),
): Check {
  const match = ENGINES_FLOOR.exec(range.trim());
  if (match === null) {
    return check('Node.js', 'warn', `v${running} (cannot read the required version: "${range}")`);
  }
  const floor = match.slice(1).map(Number);
  const supported = atLeast(running.split('.').map(Number), floor);
  return supported
    ? check('Node.js', 'pass', `v${running} (requires ${range})`)
    : check('Node.js', 'fail', `v${running} is too old; CommandVault requires Node.js ${range}`);
}

async function checkClaudeDir(dir: string): Promise<Check> {
  const kind = await kindOf(dir);
  if (kind === 'directory') {
    return check('Claude directory', 'pass', `${dir} exists`);
  }
  return check(
    'Claude directory',
    'fail',
    `${dir} ${PROBLEM_BY_KIND[kind]}; install Claude Code or pass --claude-path`,
  );
}

async function checkSettings(claudeDir: string): Promise<Check> {
  const path = join(claudeDir, 'settings.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return check('settings.json', 'info', `${path} not found (optional; no hooks are indexed)`);
    }
    return check('settings.json', 'fail', `${path} cannot be read: ${describeError(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return check('settings.json', 'fail', `${path} is not valid JSON: ${describeError(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return check('settings.json', 'fail', `${path} must contain a JSON object`);
  }
  const hasHooks = 'hooks' in parsed;
  return check('settings.json', 'pass', `${path} is valid${hasHooks ? '' : ' (no hooks section)'}`);
}

async function checkOptionalDirectory(claudeDir: string, folder: string, noun: string) {
  const path = join(claudeDir, folder);
  const name = `${folder} directory`;
  const kind = await kindOf(path);
  if (kind === 'missing') {
    return check(name, 'info', `${path} not found (optional)`);
  }
  if (kind !== 'directory') {
    return check(name, 'warn', `${path} ${PROBLEM_BY_KIND[kind]}`);
  }
  try {
    const count = (await readdir(path)).length;
    return check(name, 'pass', `${path}: ${plural(count, noun)} found`);
  } catch (error) {
    return check(name, 'warn', `${path} cannot be read: ${describeError(error)}`);
  }
}

async function checkInstalledPlugins(claudeDir: string): Promise<Check> {
  const path = join(claudeDir, 'plugins', 'installed_plugins.json');
  const name = 'installed_plugins.json';
  try {
    JSON.parse(await readFile(path, 'utf-8'));
    return check(name, 'pass', `${path} is valid JSON`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return check(name, 'info', `${path} not found (optional)`);
    }
    return check(name, 'warn', `${path} is not usable: ${describeError(error)}`);
  }
}

interface ConfigOutcome {
  readonly check: Check;
  readonly config: CliConfig | undefined;
}

/** config.json is optional, but a file that exists has to parse and hold valid values. */
async function checkConfigFile(): Promise<ConfigOutcome> {
  const path = configFilePath();
  const name = 'config.json';
  try {
    const raw = await readFile(path, 'utf-8');
    const document: unknown = JSON.parse(raw);
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      return {
        check: check(name, 'fail', `${path} must contain a JSON object`),
        config: undefined,
      };
    }
    return { check: check(name, 'pass', `${path} is valid`), config: await loadConfig() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { check: check(name, 'info', `${path} not found (defaults in use)`), config: {} };
    }
    return { check: check(name, 'fail', `${path}: ${describeError(error)}`), config: undefined };
  }
}

async function checkDataDir(dir: string): Promise<Check> {
  const name = 'CommandVault directory';
  const kind = await kindOf(dir);
  if (kind === 'directory') {
    return check(name, 'pass', `${dir} exists`);
  }
  const hint = kind === 'missing' ? '; run `vault init` first' : '';
  return check(name, 'fail', `${dir} ${PROBLEM_BY_KIND[kind]}${hint}`);
}

function describeProblems(errors: readonly ParseError[], warnings: number): Check {
  const name = 'Parse problems';
  if (errors.length === 0 && warnings === 0) {
    return check(name, 'pass', 'none');
  }
  const files = new Set(errors.map((error) => error.filePath)).size;
  const parts = [
    ...(errors.length > 0 ? [`${plural(errors.length, 'error')} in ${plural(files, 'file')}`] : []),
    ...(warnings > 0 ? [plural(warnings, 'warning')] : []),
  ];
  return check(name, errors.length > 0 ? 'warn' : 'info', parts.join(', '));
}

/** Every source the parsers read but that Claude Code only creates once it is used. */
function optionalSources(claudeDir: string): ReadonlySet<string> {
  const folders = ['skills', 'agents', 'commands', 'rules'].map((folder) =>
    join(claudeDir, folder),
  );
  const files = [
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    join(claudeDir, 'settings.json'),
  ];
  return new Set([...folders, ...files].map((path) => resolve(path)));
}

/**
 * The parsers report an absent optional source as an error. That is a gap, not a problem with the
 * user's files, and the rows above already say so, so it is not counted as a parse problem.
 */
async function withoutAbsentSources(
  errors: readonly ParseError[],
  claudeDir: string,
): Promise<readonly ParseError[]> {
  const optional = optionalSources(claudeDir);
  const absent = await Promise.all(
    errors.map(async (error) => {
      const isOptional = optional.has(resolve(error.filePath));
      return isOptional && (await kindOf(error.filePath)) === 'missing';
    }),
  );
  return errors.filter((_error, index) => !absent[index]);
}

interface Scan {
  readonly entries: number;
  readonly errors: readonly ParseError[];
  /** Core found the copy unreadable, moved it aside and started a new one. */
  readonly wasCorrupt: boolean;
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** The scratch directory only ever holds a `.corrupt.<time>.bak` after core quarantined the copy. */
async function wasQuarantined(scratch: string): Promise<boolean> {
  return (await readdir(scratch)).some((name) => CORRUPT_BACKUP.test(name));
}

/**
 * Doctor never opens the user's vault.db for writing: opening it is how a vault rescans and prunes
 * its index, and moves a corrupt file aside. The scan runs on a copy inside a throwaway directory.
 */
async function scanEntries(
  options: CliGlobalOptions,
  config: CliConfig,
  databasePath: string,
  databaseExists: boolean,
): Promise<Scan> {
  const scratch = await mkdtemp(join(tmpdir(), TEMP_DB_PREFIX));
  const scratchDb = join(scratch, 'vault.db');
  try {
    if (databaseExists) {
      await copyFile(databasePath, scratchDb);
      await copyIfPresent(`${databasePath}-wal`, `${scratchDb}-wal`);
    }
    const vault = await createConfiguredVault(options, false, { config, dbPath: scratchDb });
    try {
      const stats = await vault.initialize();
      const wasCorrupt = await wasQuarantined(scratch);
      return { entries: stats.totalEntries, errors: vault.getErrors(), wasCorrupt };
    } finally {
      await vault.dispose();
    }
  } catch (error) {
    throw error instanceof DatabaseOpenError
      ? new DatabaseOpenError(
          error.message.replaceAll(scratchDb, databasePath),
          databasePath,
          error,
        )
      : error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function entriesCheck(entries: number, claudeDir: string): Check {
  return entries > 0
    ? check('Entries', 'pass', `${entries === 1 ? '1 entry' : `${entries} entries`} indexed`)
    : check('Entries', 'warn', `0 entries found; nothing under ${claudeDir} is indexed`);
}

function databaseCheck(path: string, exists: boolean, wasCorrupt: boolean): Check {
  if (wasCorrupt) {
    return check(
      'Database',
      'fail',
      `${path} is not a valid SQLite database; the next command that opens the vault moves it ` +
        'aside (as vault.db.corrupt.<time>.bak) and starts a new index',
    );
  }
  return exists
    ? check('Database', 'pass', `${path} opened (checked on a copy; the file was not touched)`)
    : check(
        'Database',
        'info',
        `${path} not created yet; the first command that opens the vault creates it`,
      );
}

async function inspectVault(
  options: CliGlobalOptions,
  config: CliConfig,
  claudeDir: string,
): Promise<VaultInspection> {
  const databasePath = dbFilePath();
  const databaseExists = (await kindOf(databasePath)) === 'file';
  try {
    const scan = await scanEntries(options, config, databasePath, databaseExists);
    const warnings = scan.errors.filter((error) => getParseSeverity(error) === 'warning').length;
    const errors = (await withoutAbsentSources(scan.errors, claudeDir)).filter(
      (error) => getParseSeverity(error) === 'error',
    );
    return {
      checks: [
        databaseCheck(databasePath, databaseExists, scan.wasCorrupt),
        entriesCheck(scan.entries, claudeDir),
        describeProblems(errors, warnings),
      ],
      errors,
    };
  } catch (error) {
    const failed =
      error instanceof DatabaseOpenError
        ? check('Database', 'fail', error.message)
        : check('Vault scan', 'fail', `scan failed: ${describeError(error)}`);
    return { checks: [failed], errors: [] };
  }
}

function tally(checks: readonly Check[]): Readonly<Record<CheckStatus, number>> {
  const counts = { pass: 0, info: 0, warn: 0, fail: 0 };
  for (const entry of checks) {
    counts[entry.status] += 1;
  }
  return counts;
}

function renderReport(
  checks: readonly Check[],
  counts: Readonly<Record<CheckStatus, number>>,
  errors: readonly ParseError[],
): void {
  const width = Math.max(...checks.map((entry) => entry.name.length));
  console.log('');
  console.log(chalk.bold.white('  CommandVault Doctor'));
  console.log(chalk.dim('  ' + '='.repeat(40)));
  console.log('');
  for (const entry of checks) {
    const detail = entry.status === 'fail' ? chalk.yellow(entry.detail) : chalk.dim(entry.detail);
    console.log(`  ${STATUS_ICONS[entry.status]}  ${entry.name.padEnd(width)}  ${detail}`);
  }
  for (const error of errors.slice(0, MAX_ERRORS_LISTED)) {
    console.log(`       ${chalk.red('✗')} ${error.filePath}: ${error.message}`);
  }
  if (errors.length > MAX_ERRORS_LISTED) {
    console.log(chalk.dim(`       ... and ${errors.length - MAX_ERRORS_LISTED} more`));
  }
  console.log('');
  console.log(chalk.dim('  ' + '-'.repeat(40)));
  const summary = `${counts.pass} passed, ${counts.info} informational, ${plural(counts.warn, 'warning')}, ${counts.fail} failed`;
  console.log(
    counts.fail === 0 ? chalk.green.bold(`  ${summary}`) : chalk.red.bold(`  ${summary}`),
  );
  console.log('');
}

interface Diagnosis {
  readonly claudeDir: string;
  readonly dataDir: string;
  readonly checks: readonly Check[];
  readonly errors: readonly ParseError[];
}

async function diagnose(options: CliGlobalOptions): Promise<Diagnosis> {
  const dataDir = resolveDataDir();
  const configOutcome = await checkConfigFile();
  const config = configOutcome.config ?? {};
  const claudeDir = claudeDirFor(options, config);
  const environment = await Promise.all([
    checkNodeVersion(),
    checkClaudeDir(claudeDir),
    checkSettings(claudeDir),
    checkOptionalDirectory(claudeDir, 'skills', 'skill'),
    checkOptionalDirectory(claudeDir, 'agents', 'agent'),
    checkOptionalDirectory(claudeDir, 'commands', 'command'),
    checkInstalledPlugins(claudeDir),
    configOutcome.check,
    checkDataDir(dataDir),
  ]);
  const vault: VaultInspection =
    configOutcome.config === undefined
      ? { checks: [check('Database', 'info', 'skipped until config.json is fixed')], errors: [] }
      : await inspectVault(options, config, claudeDir);
  return { claudeDir, dataDir, checks: [...environment, ...vault.checks], errors: vault.errors };
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Check system health and diagnose configuration issues')
    .action(async (_opts, command) => {
      const options = command.optsWithGlobals() as CliGlobalOptions;
      const spinner = options.json ? null : createSpinner('Checking...', { indent: 2 }).start();
      const diagnosis = await diagnose(options);
      spinner?.stop();

      const counts = tally(diagnosis.checks);
      if (options.json) {
        const { claudeDir, dataDir, checks, errors } = diagnosis;
        const problems = errors.map(({ filePath, message }) => ({ filePath, message }));
        jsonOutput({ claudeDir, dataDir, checks, counts, problems });
      } else {
        renderReport(diagnosis.checks, counts, diagnosis.errors);
      }
      if (counts.fail > 0) {
        throw new CommandError(`${plural(counts.fail, 'required check')} failed`);
      }
    });
}
