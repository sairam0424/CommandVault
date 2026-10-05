import type * as Fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

type FsModule = typeof Fs;

/**
 * Hooks for the steps of a repair, so a test can act in the window between two of them, which is
 * where two processes collide, and can make any single step fail. Everything is unset by default.
 */
export interface FsSeam {
  /** A backup of `from` is about to be written to `to` (`to` is undefined if no name is reserved). */
  beforeCopy?: (from: string, to: string | undefined) => void;
  /** The backup `to` was written; it has not been checked yet. */
  afterCopy?: (to: string) => void;
  /** `path` is about to be created, failing if it exists (a backup name, the lock). */
  beforeCreate?: (path: string) => void;
  /** The file `from` is about to be read, in one go, for a backup. */
  beforeRead?: (from: string) => void;
  /** The file `from` was read in one go; the bytes returned are what the repair gets to see. */
  afterRead?: (from: string, content: Buffer) => Buffer;
  /** Data is about to be written to the already open file `path`. */
  beforeWrite?: (path: string) => void;
  beforeUnlink?: (path: string) => void;
  /** The folder `path` is about to be listed. */
  beforeReaddir?: (path: string) => void;
  beforeTruncate?: (path: string) => void;
  beforeRename?: (from: string, to: string) => void;
  afterRename?: (from: string, to: string) => void;
  /** A hard link `next` to `existing` is about to be made (a lock put back after a removal). */
  beforeLink?: (existing: string, next: string) => void;
}

export const seam: FsSeam = {};

export function resetSeam(): void {
  for (const hook of Object.keys(seam) as Array<keyof FsSeam>) delete seam[hook];
}

/**
 * Wraps the file system calls a repair makes. Load it from the factory of `vi.mock('node:fs')`
 * with a dynamic import: this file must not import 'node:fs' itself.
 */
export function withSeam(actual: FsModule): FsModule {
  const pathOfFd = new Map<number, string>();

  // The reserved name of the backup that a copy of `path` is going into, if a repair reserved one.
  const backupFor = (path: string): string | undefined => {
    const dbName = /^(.*?vault\.db)(-wal|-shm|-journal)?$/.exec(basename(path));
    if (dbName === null) return undefined;
    const reserved = actual
      .readdirSync(dirname(path))
      .find((name) => name.startsWith(`${dbName[1]}.corrupt.`) && name.endsWith('.bak'));
    return reserved === undefined ? undefined : join(dirname(path), reserved + (dbName[2] ?? ''));
  };

  return {
    ...actual,
    openSync: ((path: Fs.PathLike, flags?: Fs.OpenMode, mode?: Fs.Mode | null) => {
      if (flags === 'r' && typeof path === 'string') seam.beforeCopy?.(path, backupFor(path));
      if (flags === 'wx' && typeof path === 'string') seam.beforeCreate?.(path);
      const fd = actual.openSync(path, flags ?? 'r', mode);
      pathOfFd.set(fd, String(path));
      return fd;
    }) as FsModule['openSync'],
    closeSync: (fd: number) => {
      pathOfFd.delete(fd);
      actual.closeSync(fd);
    },
    readFileSync: ((file: Fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const from = typeof file === 'number' ? pathOfFd.get(file) : undefined;
      if (from !== undefined) seam.beforeRead?.(from);
      const content = (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
      if (from === undefined || seam.afterRead === undefined) return content;
      return seam.afterRead(from, content as Buffer);
    }) as FsModule['readFileSync'],
    writeFileSync: ((file: Fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const to = typeof file === 'number' ? pathOfFd.get(file) : undefined;
      if (to !== undefined) seam.beforeWrite?.(to);
      return (actual.writeFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as FsModule['writeFileSync'],
    readdirSync: ((path: Fs.PathLike, ...rest: unknown[]) => {
      seam.beforeReaddir?.(String(path));
      return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as FsModule['readdirSync'],
    fsyncSync: (fd: number) => {
      const to = pathOfFd.get(fd);
      if (to !== undefined) seam.afterCopy?.(to);
      actual.fsyncSync(fd);
    },
    copyFileSync: (from: Fs.PathLike, to: Fs.PathLike, mode?: number) => {
      seam.beforeCopy?.(String(from), String(to));
      actual.copyFileSync(from, to, mode);
      seam.afterCopy?.(String(to));
    },
    unlinkSync: (path: Fs.PathLike) => {
      seam.beforeUnlink?.(String(path));
      actual.unlinkSync(path);
    },
    truncateSync: (path: Fs.PathLike, length?: number | null) => {
      seam.beforeTruncate?.(String(path));
      actual.truncateSync(path, length ?? undefined);
    },
    renameSync: (from: Fs.PathLike, to: Fs.PathLike) => {
      seam.beforeRename?.(String(from), String(to));
      actual.renameSync(from, to);
      seam.afterRename?.(String(from), String(to));
    },
    linkSync: (existing: Fs.PathLike, next: Fs.PathLike) => {
      seam.beforeLink?.(String(existing), String(next));
      actual.linkSync(existing, next);
    },
  };
}
