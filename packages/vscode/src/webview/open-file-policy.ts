import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveClaudeDir } from '@commandvault/core';

/** Other assistants' configuration directories, under the home directory. */
const OTHER_ASSISTANT_DIRECTORIES: readonly string[] = ['.cursor', '.continue'];

/** Why a root may fail to resolve without anything being wrong: it is absent or unreadable. */
const UNUSABLE_ROOT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES']);

/**
 * The directory the user's own settings tell the extension to scan (`commandvault.claudeConfigPath`),
 * if there is one. Only the user-level value counts: a workspace's .vscode/settings.json is written
 * by whoever wrote the repository and must not widen the list of files the panel opens. A relative
 * or non-text value is ignored, since a relative one would resolve against the editor's own cwd.
 */
function userConfiguredClaudeDir(): string | undefined {
  const inspected = vscode.workspace
    .getConfiguration('commandvault')
    .inspect<string>('claudeConfigPath');
  const value = inspected?.globalValue;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? trimmed : undefined;
}

/**
 * The account's home directory, as core resolves it. Core's default Claude directory is
 * `<home>/.claude`, and its home treats an empty HOME like an unset one: `os.homedir()` returns ''
 * then (which would make `.cursor` a path relative to the editor's working directory) and throws on
 * Windows when USERPROFILE is empty. Asking with an empty environment gives that home without a
 * second copy of the logic.
 */
function accountHome(): string {
  return path.dirname(resolveClaudeDir({}));
}

/**
 * The directories whose files the detail panel may open. Evaluated on every request, never at
 * import: HOME, CLAUDE_CONFIG_DIR and the settings can differ from what they were at load.
 */
export function allowedRoots(): readonly string[] {
  const home = accountHome();
  const configured = userConfiguredClaudeDir();
  return [
    resolveClaudeDir(),
    ...(configured === undefined ? [] : [configured]),
    ...OTHER_ASSISTANT_DIRECTORIES.map((name) => path.join(home, name)),
  ];
}

/** The parts of `path` that isBelow uses, so a test can hand it `path.win32` on any OS. */
type PathFlavour = Pick<path.PlatformPath, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * True when `candidate` is below `root`: a sibling named like the root is not. On Windows,
 * `relative` returns an absolute path for a file on another drive, which is not below anything.
 */
export function isBelow(root: string, candidate: string, flavour: PathFlavour = path): boolean {
  const relative = flavour.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${flavour.sep}`) &&
    !flavour.isAbsolute(relative)
  );
}

/** A root with its symlinks resolved, or undefined when it cannot contain anything. */
async function resolveRoot(root: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && UNUSABLE_ROOT_CODES.has(code)) {
      return undefined;
    }
    throw err;
  }
}

/**
 * The real path of `requestedPath` when it is a file below an allowed directory, else undefined.
 * Both sides are resolved through symlinks first, so a link inside an allowed directory that points
 * elsewhere is refused and an allowed directory that is itself a link still works. Rejects when the
 * file does not exist.
 */
export async function resolveOpenableFile(requestedPath: unknown): Promise<string | undefined> {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    return undefined;
  }
  const realPath = await fs.promises.realpath(path.normalize(requestedPath));
  const roots = await Promise.all(allowedRoots().map(resolveRoot));
  return roots.some((root) => root !== undefined && isBelow(root, realPath)) ? realPath : undefined;
}
