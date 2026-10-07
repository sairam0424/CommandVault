import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import {
  backupFileKind,
  backupVault,
  ensurePrivate,
  removeBackupFiles,
  sweepStaleInspectCopies,
  type BackupFileKind,
  type BackupResult,
} from '@commandvault/core';
import { backupDirPath, dbFilePath } from '../config.js';
import { CommandError, EXIT_RUNTIME_ERROR } from '../errors.js';
import { jsonOutput, type CliGlobalOptions } from '../helpers.js';
import { safeText } from '../ui/safe-text.js';

/** How many `vault-*.db` copies `backup` keeps; core prunes its pre-migrate/pre-restore ones. */
const MAX_BACKUPS = 10;
const BACKUP_DIR_MODE = 0o700;
const KB = 1024;
/** The name has one-second resolution: a copy taken in a second that is taken gets the next one. */
const MS_PER_SECOND = 1000;
/** How many consecutive seconds' names `backup` tries before it gives up on a free one. */
const MAX_NAME_ATTEMPTS = 60;
const KIND_COLUMN_WIDTH = 11;
const NO_VAULT_HINT = 'run `vault list` first to create the database';

interface BackupListing {
  readonly file: string;
  readonly kind: BackupFileKind;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export function createBackupCommand(): Command {
  const cmd = new Command('backup')
    .description('Backup the vault database')
    .option('--list', 'List available backups')
    .action(async (opts: { list?: boolean }, command: Command) => {
      const { json = false } = command.optsWithGlobals() as CliGlobalOptions;
      // Opens no Vault, so the private modes a 0.1.0 vault never got are re-applied here.
      ensurePrivate(dbFilePath());
      sweepStaleInspectCopies(backupDirPath());
      if (opts.list) {
        await listBackups(json);
        return;
      }
      await createBackup(json);
    });

  return cmd;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function backupFileName(now: Date): string {
  return `vault-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
}

function backupFailure(error: unknown): CommandError {
  const message = error instanceof Error ? error.message : String(error);
  return new CommandError(`backup failed: ${safeText(message)}`, EXIT_RUNTIME_ERROR);
}

/**
 * Backs up to the first free name: this second's, else the next second's, and so on. Core creates
 * the copy exclusively and answers EEXIST for a name that is taken, so a copy of this second and a
 * backup another process is writing right now are told apart without a race between look and take.
 */
async function backupToFreeName(
  dbPath: string,
  backupDir: string,
): Promise<{ path: string; result: BackupResult }> {
  const start = Date.now();
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const path = join(backupDir, backupFileName(new Date(start + attempt * MS_PER_SECOND)));
    try {
      return { path, result: await backupVault(dbPath, path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw backupFailure(error);
    }
  }
  const message = `backup failed: no free backup name in ${safeText(backupDir)}`;
  throw new CommandError(message, EXIT_RUNTIME_ERROR);
}

async function createBackup(json: boolean): Promise<void> {
  const dbPath = dbFilePath();
  // Before any mkdir: a fresh home stays empty instead of gaining a backups folder and a hint.
  if (!(await isRegularFile(dbPath))) {
    const message = `backup failed: no vault database at ${safeText(dbPath)}`;
    throw new CommandError(message, EXIT_RUNTIME_ERROR, NO_VAULT_HINT);
  }
  const backupDir = backupDirPath();
  await mkdir(backupDir, { recursive: true, mode: BACKUP_DIR_MODE });
  const { path, result } = await backupToFreeName(dbPath, backupDir);
  const pruned = await pruneBackups(backupDir);

  if (result.warning !== undefined) {
    console.error(chalk.yellow(`warning: ${safeText(result.warning)}`));
  }
  if (json) {
    jsonOutput({ path, kind: result.kind, bytes: result.bytes, warning: result.warning, pruned });
    return;
  }
  console.log(chalk.green(`\nBackup created: ${safeText(path)}\n`));
  if (pruned > 0) {
    console.log(chalk.dim(`Pruned ${pruned} old backup(s) (keeping last ${MAX_BACKUPS})`));
  }
}

/** The backups among `names`, newest first; a name of any other shape is not one. */
async function describeBackups(
  backupDir: string,
  names: readonly string[],
): Promise<BackupListing[]> {
  const listed = await Promise.all(
    names.map(async (file): Promise<BackupListing | undefined> => {
      const kind = backupFileKind(file);
      if (kind === undefined) return undefined;
      const stats = await lstat(join(backupDir, file));
      if (!stats.isFile()) return undefined;
      return { file, kind, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
    }),
  );
  return listed
    .filter((entry): entry is BackupListing => entry !== undefined)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.file.localeCompare(a.file));
}

function formatRow(entry: BackupListing, nameWidth: number): string {
  const size = `${(entry.bytes / KB).toFixed(1)} KB`.padStart(10);
  const date = entry.modifiedAt.slice(0, 16).replace('T', ' ');
  return (
    `  ${chalk.cyan(safeText(entry.file).padEnd(nameWidth))}  ` +
    `${entry.kind.padEnd(KIND_COLUMN_WIDTH)}${chalk.dim(size)}  ${chalk.dim(date)}`
  );
}

async function listBackups(json: boolean): Promise<void> {
  const backupDir = backupDirPath();
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    // A regular file under the folder's name (ENOTDIR) means the same: there is no such directory.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    if (json) jsonOutput({ backups: [] });
    else console.log(chalk.yellow('\nNo backups directory found.\n'));
    return;
  }
  const backups = await describeBackups(backupDir, names);
  if (json) {
    jsonOutput({ backups });
    return;
  }
  const others = names.length - backups.length;
  if (backups.length === 0) {
    console.log(chalk.yellow('\nNo backups found. Run `vault backup` to create one.\n'));
  } else {
    console.log(chalk.bold('\n  Available backups:\n'));
    const nameWidth = Math.max(...backups.map((entry) => safeText(entry.file).length));
    for (const entry of backups) console.log(formatRow(entry, nameWidth));
    console.log('');
  }
  if (others > 0) {
    console.log(chalk.dim(`  ${others} other file(s) in ${safeText(backupDir)} are not backups\n`));
  }
}

/** Removes the oldest `vault-*.db` copies beyond MAX_BACKUPS (sidecars too), by name; the count. */
async function pruneBackups(backupDir: string): Promise<number> {
  const names = await readdir(backupDir);
  const manual = names.filter((name) => backupFileKind(name) === 'manual').sort();
  const toRemove = manual.slice(0, Math.max(0, manual.length - MAX_BACKUPS));
  let removed = 0;
  for (const file of toRemove) {
    try {
      removeBackupFiles(join(backupDir, file));
      removed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        chalk.yellow(`warning: could not prune ${safeText(file)}: ${safeText(message)}`),
      );
    }
  }
  return removed;
}
