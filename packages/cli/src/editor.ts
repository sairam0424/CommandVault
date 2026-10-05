import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { CommandError, EXIT_RUNTIME_ERROR } from './errors.js';

/** The part of `spawnSync` the editor launcher uses; tests supply their own. */
export type SpawnEditor = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

export interface OpenInEditorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnEditor;
  /** Lets tests stand in for the file system when searching PATH on Windows. */
  readonly exists?: (candidate: string) => boolean;
}

/** How to start one editor: the command, its arguments and whether the shell must run it. */
export interface EditorInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export interface EditorCandidates {
  /** Each entry is a command followed by its arguments. */
  readonly candidates: readonly (readonly string[])[];
  /** True when $VISUAL or $EDITOR named the editor, so nothing else may be substituted. */
  readonly isConfigured: boolean;
}

const EDITOR_VARIABLES = ['VISUAL', 'EDITOR'] as const;
const FALLBACK_EDITORS: Readonly<Record<'win32' | 'other', readonly string[]>> = {
  win32: ['code', 'notepad'],
  other: ['code', 'vi'],
};
const OVERRIDE_HINT = 'set $VISUAL or $EDITOR to override';
const WINDOWS_SHELL_EXTENSIONS = ['.cmd', '.bat'];
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
// Inside double quotes a POSIX shell only lets a backslash escape these.
const ESCAPABLE_IN_DOUBLE_QUOTES = '"\\$`';

/**
 * Splits a command line such as `code --wait` or `"/my tools/ed" -f` into its parts, the way a
 * shell would word-split it. Backslash is a path separator on Windows, an escape elsewhere.
 */
export function splitCommandLine(
  text: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const isWindows = platform === 'win32';
  const parts: string[] = [];
  let current = '';
  let hasPart = false;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (quote !== null) {
      const isEscape =
        quote === '"' &&
        ch === '\\' &&
        !isWindows &&
        next !== '' &&
        ESCAPABLE_IN_DOUBLE_QUOTES.includes(next);
      if (ch === quote) quote = null;
      else if (isEscape) current += text.charAt(++i);
      else current += ch;
    } else if (ch === '"' || (ch === "'" && !isWindows)) {
      quote = ch;
      hasPart = true;
    } else if (ch === '\\' && !isWindows && next !== '') {
      current += text.charAt(++i);
      hasPart = true;
    } else if (/\s/.test(ch)) {
      if (hasPart) parts.push(current);
      current = '';
      hasPart = false;
    } else {
      current += ch;
      hasPart = true;
    }
  }
  if (quote !== null) throw new CommandError(`unterminated ${quote} quote`);
  if (hasPart) parts.push(current);
  return parts;
}

function parseConfigured(name: string, value: string, platform: NodeJS.Platform): string[] {
  try {
    return splitCommandLine(value, platform);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `$${name} is not a valid command line: ${reason}`,
      EXIT_RUNTIME_ERROR,
      OVERRIDE_HINT,
    );
  }
}

/**
 * The editor to run: the first of $VISUAL and $EDITOR that holds a command, else the platform
 * fallbacks in order. A configured editor is never swapped for another one.
 */
export function resolveEditorCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): EditorCandidates {
  for (const name of EDITOR_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) continue;
    const parts = parseConfigured(name, value, platform);
    if (parts.length > 0 && parts[0] !== '') return { candidates: [parts], isConfigured: true };
  }
  const fallbacks = platform === 'win32' ? FALLBACK_EDITORS.win32 : FALLBACK_EDITORS.other;
  return { candidates: fallbacks.map((command) => [command]), isConfigured: false };
}

const hasSeparator = (command: string): boolean => /[\\/]/.test(command);

function windowsExtension(command: string): string {
  return win32.extname(command).toLowerCase();
}

/** Looks a bare command up on PATH with each PATHEXT extension, as cmd.exe would. */
function findOnWindowsPath(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): string | undefined {
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  const extensions = (env['PATHEXT'] ?? DEFAULT_PATHEXT).split(';').filter(Boolean);
  for (const dir of pathValue.split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = win32.join(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

const quoteForCmd = (text: string): string => `"${text.replace(/"/g, '\\"')}"`;

/**
 * Builds the spawn arguments for one editor. On Windows a `.cmd` or `.bat` (VS Code's `code` is
 * one) cannot be started without the shell, and the shell needs every part quoted.
 */
export function planInvocation(
  parts: readonly string[],
  filePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = existsSync,
): EditorInvocation {
  const [first = '', ...rest] = parts;
  if (platform !== 'win32') {
    return { command: first, args: [...rest, posix.resolve(filePath)], shell: false };
  }
  const file = win32.resolve(filePath);
  const canSearchPath = !hasSeparator(first) && windowsExtension(first) === '';
  const command = (canSearchPath ? findOnWindowsPath(first, env, exists) : undefined) ?? first;
  const extension = windowsExtension(command);
  if (WINDOWS_SHELL_EXTENSIONS.includes(extension)) {
    return {
      command: quoteForCmd(command),
      args: [...rest, file].map(quoteForCmd),
      shell: true,
    };
  }
  return { command, args: [...rest, file], shell: false };
}

type Outcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly message: string };

function describeFailure(result: SpawnSyncReturns<Buffer | string>, label: string): Outcome {
  const cannotStart = (reason: string): Outcome => ({
    kind: 'failed',
    message: `failed to open editor (${label}): ${reason}`,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return cannotStart('permission denied');
    return cannotStart(result.error.message);
  }
  if (result.signal) {
    return { kind: 'failed', message: `editor (${label}) was stopped by ${result.signal}` };
  }
  if (result.status !== 0) {
    return {
      kind: 'failed',
      message: `editor (${label}) exited with status ${String(result.status)}`,
    };
  }
  return { kind: 'ok' };
}

type ResolvedOptions = Required<Pick<OpenInEditorOptions, 'env' | 'platform' | 'spawn' | 'exists'>>;

function runOne(parts: readonly string[], filePath: string, options: ResolvedOptions): Outcome {
  const plan = planInvocation(parts, filePath, options.platform, options.env, options.exists);
  const result = options.spawn(plan.command, plan.args, { stdio: 'inherit', shell: plan.shell });
  return describeFailure(result, parts.join(' '));
}

/**
 * Opens a file in the user's editor and waits for it to close. The editor inherits the terminal,
 * so a terminal editor works; throws a CommandError (exit 1) when no editor starts or it fails.
 */
export function openInEditor(filePath: string, options: OpenInEditorOptions = {}): void {
  const resolved: ResolvedOptions = {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    spawn: options.spawn ?? (spawnSync as unknown as SpawnEditor),
    exists: options.exists ?? existsSync,
  };
  const { candidates, isConfigured } = resolveEditorCandidates(resolved.env, resolved.platform);

  for (const parts of candidates) {
    const outcome = runOne(parts, filePath, resolved);
    if (outcome.kind === 'ok') return;
    if (outcome.kind === 'failed') {
      throw new CommandError(outcome.message, EXIT_RUNTIME_ERROR, OVERRIDE_HINT);
    }
    if (isConfigured) {
      const message = `failed to open editor (${parts.join(' ')}): command not found`;
      throw new CommandError(message, EXIT_RUNTIME_ERROR, OVERRIDE_HINT);
    }
  }
  const tried = candidates.map((parts) => parts.join(' ')).join(', ');
  throw new CommandError(`no editor found (tried ${tried})`, EXIT_RUNTIME_ERROR, OVERRIDE_HINT);
}
