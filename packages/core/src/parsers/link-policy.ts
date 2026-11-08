import { lstat, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { VaultEntry } from '../types/index.js';
import { SkippedFileError, readBoundedText, type OpenedFileCheck } from './bounded-read.js';
import { safePath } from './utils.js';

/**
 * What to open for a file a scan found, and whether the file itself was a symbolic link. Two
 * policies exist. Inside the Claude configuration directory links are the user's own (skills linked
 * from a shared repository): a link is followed and, when it leads to an entry, recorded as
 * `metadata.linkTarget` plus the `symlink` tag. Under `--project` the directory is untrusted: a file
 * whose real path leaves the project root is skipped, so a `CLAUDE.md` pointing at `~/.ssh` is never
 * read. A linked skill directory is not a file link: the `SKILL.md` below it is a regular file, so it
 * is followed as before and not recorded.
 */
export interface ResolvedRead {
  /**
   * The path to open and to stat: the real path when the file is a link, else the path as found.
   * The C library's realpath can follow a chain of links one longer than the kernel's stat does
   * (33 against 32 on macOS, for a path with no other links in it), so the times recorded are
   * those of the file that was read, not of the link path.
   */
  readonly readPath: string;
  /** The link's real target, set only when the file itself is a symbolic link. */
  readonly linkTarget?: string;
  /**
   * Set when the path was only validated, not yet opened: it judges the handle the open returned
   * (see `confirmStillInside`). Read with `readLinkedText`, which applies it.
   */
  readonly confirmOpened?: OpenedFileCheck;
}

export type LinkPolicy = (filePath: string) => Promise<ResolvedRead>;

export const SYMLINK_TAG = 'symlink';

/** A dangling link or a loop: there is nothing to read. */
export class UnresolvableLinkError extends SkippedFileError {
  constructor(filePath: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
    super(filePath, `${filePath} is a symlink that cannot be resolved (${code})`);
    this.name = 'UnresolvableLinkError';
  }
}

/** The real path lies outside the directory being scanned, so the file is not the project's. */
export class UncontainedFileError extends SkippedFileError {
  constructor(filePath: string, root: string) {
    super(filePath, `${filePath} resolves outside the project directory ${root}`);
    this.name = 'UncontainedFileError';
  }
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  return (await lstat(filePath)).isSymbolicLink();
}

/** Trusted directories: a link is followed to its real target and recorded. */
export const followFileLinks: LinkPolicy = async (filePath) => {
  if (!(await isSymbolicLink(filePath))) return { readPath: filePath };
  try {
    const target = await realpath(filePath);
    return { readPath: target, linkTarget: target };
  } catch (err) {
    throw new UnresolvableLinkError(filePath, err);
  }
};

async function resolvesAtAll(filePath: string): Promise<unknown> {
  try {
    await realpath(filePath);
    return null;
  } catch (err) {
    return err;
  }
}

/** The path was swapped between its validation and the open: the file opened is not the one approved. */
export class FileChangedError extends SkippedFileError {
  constructor(filePath: string) {
    super(filePath, `${filePath} changed while it was being opened, so it was not read`);
    this.name = 'FileChangedError';
  }
}

/** True when `path` is, right now, its own real path and lies inside one of `roots`. */
async function isOwnRealPathInside(path: string, roots: readonly string[]): Promise<boolean> {
  return (await safePath(path, roots)) === path;
}

/** True when `path` is, right now, a plain file (not a link) with the identity of the opened one. */
async function isTheOpenedFile(path: string, opened: BigIntStats): Promise<boolean> {
  const current = await lstat(path, { bigint: true }).catch(() => null);
  if (current === null || current.isSymbolicLink()) return false;
  return current.dev === opened.dev && current.ino === opened.ino;
}

/**
 * The check for a path `safePath` validated against `roots`, made on the handle the open returned.
 * Validating first and opening second leaves a gap in which a writer can put a link in place of
 * the file, or of a directory above it, so the open can land on a file outside the roots. Opening
 * first and judging the handle closes it: the path must (still) be its own real path inside the
 * roots, and be a plain file with the device and inode of the file the handle holds, and be so
 * again after that comparison. A swapped-in link fails the second test whatever it points at; a
 * link above the file fails the first or the third. The bytes come from the handle, so nothing can
 * redirect the read afterwards. What this cannot exclude is a writer that swaps a directory above
 * the file back and forth in step with each of these three checks (Node has no openat to resolve
 * the path relative to a pinned directory), and a hard link to an outside file, which is that file
 * under another name; both take write access inside the project.
 */
export function confirmStillInside(readPath: string, roots: readonly string[]): OpenedFileCheck {
  return async (handle) => {
    const opened = await handle.stat({ bigint: true });
    const confirmed =
      (await isOwnRealPathInside(readPath, roots)) &&
      (await isTheOpenedFile(readPath, opened)) &&
      (await isOwnRealPathInside(readPath, roots));
    if (!confirmed) throw new FileChangedError(readPath);
  };
}

/** Reads a file whose real path was validated against `roots`, confirming the handle that was opened. */
export function readContainedText(readPath: string, roots: readonly string[]): Promise<string> {
  return readBoundedText(readPath, undefined, confirmStillInside(readPath, roots));
}

/** Reads what a link policy resolved, applying the policy's check to the handle when it set one. */
export function readLinkedText(link: ResolvedRead): Promise<string> {
  return readBoundedText(link.readPath, undefined, link.confirmOpened);
}

/**
 * Untrusted directories: the real path must lie inside `root` (`safePath`: realpath on both sides,
 * then `isInsideRoot`). That real path is what is opened, and the handle is then confirmed to be
 * the file now found at it inside `root`, so a swap after the check cannot get a file from outside
 * indexed (`confirmStillInside`).
 */
export function containedIn(root: string): LinkPolicy {
  return async (filePath) => {
    const isLink = await isSymbolicLink(filePath);
    const readPath = await safePath(filePath, [root]);
    if (readPath === null) {
      const unresolved = isLink ? await resolvesAtAll(filePath) : null;
      throw unresolved === null
        ? new UncontainedFileError(filePath, root)
        : new UnresolvableLinkError(filePath, unresolved);
    }
    const confirmOpened = confirmStillInside(readPath, [root]);
    return isLink ? { readPath, linkTarget: readPath, confirmOpened } : { readPath, confirmOpened };
  };
}

/** The metadata a followed file link adds to its entry; nothing for a regular file. */
export function linkMetadata(resolved: ResolvedRead): Readonly<Record<string, unknown>> {
  return resolved.linkTarget === undefined ? {} : { linkTarget: resolved.linkTarget };
}

/** The tags a followed file link adds to its entry; nothing for a regular file. */
export function linkTags(resolved: ResolvedRead): readonly string[] {
  return resolved.linkTarget === undefined ? [] : [SYMLINK_TAG];
}

/** A copy of `entry` with the link fields added, for builders that assemble the entry first. */
export function withLinkFields(entry: VaultEntry, resolved: ResolvedRead): VaultEntry {
  if (resolved.linkTarget === undefined) return entry;
  return {
    ...entry,
    tags: [...entry.tags, ...linkTags(resolved)],
    metadata: { ...entry.metadata, ...linkMetadata(resolved) },
  };
}
