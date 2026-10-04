import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Where CommandVault keeps its own state and where it reads Claude's configuration from.
 *
 * Both are evaluated when they are called, never at import: a module-level `homedir()` constant
 * froze the home directory for the life of the process, so setting HOME or COMMANDVAULT_HOME after
 * the package was loaded had no effect (CV-G2-094). They never throw on an unset HOME, because
 * Node then falls back to the account's passwd home, which is a legitimate setup for a service user.
 */

type EnvLike = Readonly<Record<string, string | undefined>>;

const DATA_DIR_VARIABLE = 'COMMANDVAULT_HOME';
const CLAUDE_DIR_VARIABLE = 'CLAUDE_CONFIG_DIR';
const DATA_DIR_NAME = '.commandvault';
const CLAUDE_DIR_NAME = '.claude';
const HOME_SHORTHAND = '~';

/**
 * The account's home directory. `os.homedir()` already falls back to the passwd entry when HOME is
 * unset, but it returns '' when HOME is set and empty, which would turn every default below into a
 * path relative to the current directory. Treat an empty HOME like an unset one.
 */
function userHome(): string {
  return homedir() || userInfo().homedir;
}

/** `~` or `~/x` (and `~\x` where the separator is a backslash) refer to the home directory. */
function isHomeShorthand(value: string): boolean {
  if (!value.startsWith(HOME_SHORTHAND)) return false;
  if (value.length === HOME_SHORTHAND.length) return true;
  const next = value.charAt(HOME_SHORTHAND.length);
  return next === '/' || next === sep;
}

function expandHomeShorthand(value: string): string {
  return isHomeShorthand(value) ? join(userHome(), value.slice(HOME_SHORTHAND.length)) : value;
}

/** The variable as an absolute path, or undefined when it is unset, empty or only whitespace. */
function pathFromVariable(env: EnvLike, variable: string): string | undefined {
  const trimmed = env[variable]?.trim();
  if (!trimmed) return undefined;
  return resolve(expandHomeShorthand(trimmed));
}

/** `COMMANDVAULT_HOME` when set, else `<home>/.commandvault`. Holds vault.db, config.json, backups. */
export function resolveDataDir(env: EnvLike = process.env): string {
  return pathFromVariable(env, DATA_DIR_VARIABLE) ?? resolve(userHome(), DATA_DIR_NAME);
}

/** `CLAUDE_CONFIG_DIR` when set, else `<home>/.claude`. The directory the parsers scan. */
export function resolveClaudeDir(env: EnvLike = process.env): string {
  return pathFromVariable(env, CLAUDE_DIR_VARIABLE) ?? resolve(userHome(), CLAUDE_DIR_NAME);
}
