import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import chalk from 'chalk';
import { resolveDataDir, type SearchTier } from '@commandvault/core';
import { CommandError, EXIT_RUNTIME_ERROR, invalidChoiceError, usageError } from './errors.js';

const CONFIG_FILE_NAME = 'config.json';
const DB_FILE_NAME = 'vault.db';
const BACKUP_DIR_NAME = 'backups';

/** config.json can name a project path and a Claude directory, so only its owner may read it. */
const CONFIG_FILE_MODE = 0o600;
const DATA_DIR_MODE = 0o700;

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
 * Resolves a directory-valued option (leading `~` expanded, made absolute) and checks that it is
 * an existing directory. Never creates it.
 */
function resolveDirectoryOption(flag: string, input: string, hint?: string): string {
  if (input.trim() === '') {
    // resolve('') is the current directory, which would silently index whatever the shell is in.
    throw usageError(`${flag} must not be empty`);
  }
  const absolute = resolve(expandHome(input));
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' || code === 'ENOTDIR' ? 'does not exist' : `is unreadable (${code})`;
    throw usageError(`${flag} "${input}" ${reason}`, hint);
  }
  if (!isDirectory) {
    throw usageError(`${flag} "${input}" is not a directory`);
  }
  return absolute;
}

/** Validates a `--claude-path` value and returns it as an absolute path. */
export function resolveClaudePath(input: string): string {
  return resolveDirectoryOption('--claude-path', input);
}

const PROJECT_HINT =
  'write --project=<dir>, or put a bare --project after the command (vault list --project)';

/** Validates a `--project [dir]` value; the bare form (`true`) means the current directory. */
export function resolveProjectRoot(input: string | true): string {
  return input === true ? process.cwd() : resolveDirectoryOption('--project', input, PROJECT_HINT);
}

const GLOBAL_VALUE_OPTIONS = ['claudePath', 'tier', 'project'] as const;

/** `claudePath` -> `claude-path`: the flag spelling of a commander option name. */
export function camelToKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The argv tokens that carry the global options to a lazily loaded command. Only the four globals
 * are forwarded: the root program also owns `--tui`/`--no-tui`, which are not global options.
 * Values must already be normalised (the root `preAction` hook makes a bare `--project` absolute).
 */
export function globalOptionArgs(rootOptions: Readonly<Record<string, unknown>>): string[] {
  const args: string[] = rootOptions['json'] === true ? ['--json'] : [];
  for (const name of GLOBAL_VALUE_OPTIONS) {
    const value = rootOptions[name];
    if (typeof value === 'string') {
      args.push(`--${camelToKebab(name)}`, value);
    }
  }
  return args;
}

/** The parsed config.json: known keys are type-checked on write, any other key is carried along. */
export type ConfigDocument = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is ConfigDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Config warnings are diagnostics, so they go to stderr and never pollute `--json` output. */
function warn(message: string): void {
  console.error(chalk.yellow(message));
}

const DEFAULTS_NOTICE =
  'Using default configuration. Fix the file or delete it to silence this warning.';

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

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    warn(`Warning: Malformed JSON in config file: ${configPath}`);
    warn(DEFAULTS_NOTICE);
    return {};
  }
  if (!isPlainObject(json)) {
    warn(`Warning: Config file is not a JSON object: ${configPath}`);
    warn(DEFAULTS_NOTICE);
    return {};
  }
  const parsed = json;

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

/** Every key `vault config set` accepts; the same keys `vault init` writes. */
export const CONFIG_KEYS = [
  'claudeConfigPath',
  'searchTier',
  'enableWatcher',
  'projectPaths',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const CONFIG_FILE_HINT = 'fix the file by hand, or run `vault init --reset` to recreate it';

/**
 * Reads config.json for a command that may change it. A missing file is an empty config; a file
 * that cannot be read, is not valid JSON or is not a JSON object is an error, never `{}`: the
 * caller is about to write, and writing `{}` over the user's settings is exactly the damage to avoid.
 */
export async function readConfigDocument(): Promise<ConfigDocument> {
  const path = configFilePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw new CommandError(`cannot read config file ${path} (${code})`, EXIT_RUNTIME_ERROR);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `malformed config file ${path}: ${reason}`,
      EXIT_RUNTIME_ERROR,
      CONFIG_FILE_HINT,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CommandError(
      `malformed config file ${path}: expected a JSON object`,
      EXIT_RUNTIME_ERROR,
      CONFIG_FILE_HINT,
    );
  }
  return parsed;
}

const DOCUMENT_SHAPES: ReadonlyArray<
  readonly [key: string, expected: string, isValid: (value: unknown) => boolean]
> = [
  ['claudeConfigPath', 'a string', (value) => typeof value === 'string'],
  ['enableWatcher', 'true or false', (value) => typeof value === 'boolean'],
  ['projectPaths', 'an array of strings', isStringArray],
  ['registries', 'an array', Array.isArray],
];

/** Throws a usage error naming the first key whose value `vault` could not use. */
export function assertValidConfigDocument(document: ConfigDocument, path: string): void {
  if (document['searchTier'] !== undefined && !isSearchTier(document['searchTier'])) {
    throw invalidChoiceError('searchTier', document['searchTier'], SEARCH_TIERS, path);
  }
  for (const [key, expected, isValid] of DOCUMENT_SHAPES) {
    if (document[key] !== undefined && !isValid(document[key])) {
      throw usageError(`invalid ${key} in ${path} (expected ${expected})`);
    }
  }
}

/** The file a write must land on: a symlinked config.json (dotfile managers) is written through. */
async function resolveWriteTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return path;
    }
    throw err;
  }
}

/**
 * Replaces `target` without ever exposing a half-written file: the bytes go to a private sibling
 * file that is flushed to disk and then renamed over `target`, so a kill or a full disk leaves
 * either the old config or the new one. The temp file is removed when the write fails.
 */
async function replaceFileAtomically(target: string, content: string): Promise<void> {
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    const handle = await open(tempPath, 'w', CONFIG_FILE_MODE);
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, target);
  } catch (err: unknown) {
    await rm(tempPath, { force: true });
    throw err;
  }
}

/**
 * Writes config.json after checking the whole document, so a command can never leave the file in
 * a state that makes every other command exit 2, nor truncated by a failed write. The data
 * directory and the file are created private (0700 / 0600).
 */
export async function writeConfigDocument(document: ConfigDocument): Promise<void> {
  const path = configFilePath();
  assertValidConfigDocument(document, path);
  await mkdir(dirname(path), { recursive: true, mode: DATA_DIR_MODE });
  await replaceFileAtomically(
    await resolveWriteTarget(path),
    JSON.stringify(document, null, 2) + '\n',
  );
}

function parseBooleanValue(key: string, raw: string): boolean {
  if (raw !== 'true' && raw !== 'false') {
    throw invalidChoiceError(key, raw, ['true', 'false']);
  }
  return raw === 'true';
}

function parsePathValue(key: string, raw: string): string {
  if (raw.trim() === '') {
    throw usageError(`${key} must not be empty`);
  }
  const expanded = expandHome(raw);
  // Only a warning: the directory may be created later (or live on a drive that is not mounted now).
  if (!pathExists(resolve(expanded))) {
    warn(`Warning: ${key} "${expanded}" does not exist (saved anyway)`);
  }
  return expanded;
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function parseStringListValue(key: string, raw: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isStringArray(parsed)) {
    throw usageError(`${key} must be a JSON array of strings`, `e.g. ${key} '["/a/b","/c"]'`);
  }
  return parsed;
}

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

/** Validates a `config set <key> <value>` pair and returns the value in the type the file stores. */
export function parseConfigValue(key: string, raw: string): unknown {
  if (!isConfigKey(key)) {
    const hint = key === 'registries' ? 'manage registries with `vault registry`' : undefined;
    throw usageError(`unknown config key "${key}" (valid keys: ${CONFIG_KEYS.join(', ')})`, hint);
  }
  switch (key) {
    case 'searchTier':
      if (!isSearchTier(raw)) {
        throw invalidChoiceError('searchTier', raw, SEARCH_TIERS);
      }
      return raw;
    case 'enableWatcher':
      return parseBooleanValue(key, raw);
    case 'claudeConfigPath':
      return parsePathValue(key, raw);
    case 'projectPaths':
      return parseStringListValue(key, raw);
  }
}
