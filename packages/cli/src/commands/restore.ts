import { Command } from 'commander';
import chalk from 'chalk';
import { basename, dirname, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { confirm } from '@inquirer/prompts';
import {
  BackupRejectedError,
  DatabaseLockedError,
  DatabaseOpenError,
  DatabasePermissionError,
  backupFileKind,
  ensurePrivate,
  inspectBackup,
  restoreVault,
  sweepStaleInspectCopies,
  type BackupInfo,
  type BackupRejectReason,
  type RestoreResult,
} from '@commandvault/core';
import { backupDirPath, dbFilePath } from '../config.js';
import { CommandError, EXIT_RUNTIME_ERROR, usageError } from '../errors.js';
import { jsonOutput, type CliGlobalOptions } from '../helpers.js';
import { safeText } from '../ui/safe-text.js';

const EXPECTED_NAMES =
  'vault-<date>T<time>.db, pre-migrate-v<n>-<stamp>.db or pre-restore-<stamp>.db';
const LIST_HINT = 'run `vault backup --list` to see available backups';
const CLOSE_HINT = 'close other CommandVault processes (VS Code, `vault watch`), then try again';
const PERMISSION_HINT =
  'check that the CommandVault directory and its files are yours and writable';
const NO_VAULT_HINT = 'run `vault list` first to create the database';
const LIVE_DATABASE_NAME = 'vault.db';

const HINT_BY_REASON: Readonly<Record<BackupRejectReason, string>> = {
  'not-a-file': LIST_HINT,
  'not-sqlite': 'only copies written by `vault backup` or by CommandVault itself can be restored',
  corrupt: 'the file is damaged; pick another backup from `vault backup --list`',
  'missing-tables': 'the file is a SQLite database, but not a CommandVault one',
  'newer-schema': 'upgrade CommandVault (`npm install -g @commandvault/cli@latest`), then restore',
};

export function createRestoreCommand(): Command {
  const cmd = new Command('restore')
    .description('Restore the vault database from a backup')
    .argument('<file>', 'Backup filename (from `vault backup --list`)')
    .option('--yes', 'Skip the confirmation')
    .action(async (file: string, opts: { yes?: boolean }, command: Command) => {
      const { json = false } = command.optsWithGlobals() as CliGlobalOptions;
      assertBackupFileName(file);
      const dbPath = dbFilePath();
      const backupPath = join(backupDirPath(), file);
      // Opens no Vault, so the private modes a 0.1.0 vault never got are re-applied here.
      ensurePrivate(dbPath);
      sweepStaleInspectCopies(backupDirPath());
      await assertBackupExists(backupPath);
      assertKnownBackupKind(file);
      const info = await inspect(backupPath, file);
      await assertVaultExists(dbPath);
      await confirmReplacement(file, dbPath, info, opts.yes === true, json);
      const result = await restore(dbPath, backupPath, file);
      report(result, file, json);
    });

  return cmd;
}

/**
 * Only a bare file name reaches backups/: a path, `.`, `..` or an empty argument would resolve to
 * the folder itself or outside it, and the live database's own name is never a backup.
 */
function assertBackupFileName(file: string): void {
  const isBare = file !== '' && file !== '.' && file !== '..' && basename(file) === file;
  if (!isBare) {
    const message = `only backup filenames are allowed (no paths); expected ${EXPECTED_NAMES}`;
    throw usageError(message, LIST_HINT);
  }
  if (file.startsWith(LIVE_DATABASE_NAME)) {
    const message =
      `only backup filenames are allowed; ${LIVE_DATABASE_NAME} is the live database, ` +
      `expected ${EXPECTED_NAMES}`;
    throw usageError(message, LIST_HINT);
  }
}

async function assertBackupExists(backupPath: string): Promise<void> {
  try {
    await lstat(backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const message = `backup file not found: ${safeText(backupPath)}`;
    throw new CommandError(message, EXIT_RUNTIME_ERROR, LIST_HINT);
  }
}

/** A file under a name CommandVault never writes is not a backup, whatever it holds. */
function assertKnownBackupKind(file: string): void {
  if (backupFileKind(file) !== undefined) return;
  const message =
    `refusing to restore ${safeText(file)}: not a backup CommandVault wrote ` +
    `(expected ${EXPECTED_NAMES})`;
  throw new CommandError(message, EXIT_RUNTIME_ERROR, LIST_HINT);
}

/**
 * A restore replaces a database; where there is none yet, `vault list` makes one. Judged after the
 * backup itself, so a file that is refused anyway is reported as such first.
 */
async function assertVaultExists(dbPath: string): Promise<void> {
  try {
    await lstat(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const message = `no vault database at ${safeText(dbPath)}`;
    throw new CommandError(message, EXIT_RUNTIME_ERROR, NO_VAULT_HINT);
  }
}

/** The typed core errors become one `error:` line with a hint; nothing reaches the user raw. */
function toCommandError(error: unknown, file: string, verb: string): CommandError {
  if (error instanceof BackupRejectedError) {
    const message = `refusing to restore ${safeText(file)}: ${safeText(error.detail)}`;
    return new CommandError(message, EXIT_RUNTIME_ERROR, HINT_BY_REASON[error.reason]);
  }
  if (error instanceof DatabaseOpenError) {
    const hint =
      error instanceof DatabaseLockedError
        ? CLOSE_HINT
        : error instanceof DatabasePermissionError
          ? PERMISSION_HINT
          : undefined;
    return new CommandError(safeText(error.message), EXIT_RUNTIME_ERROR, hint);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CommandError(`${verb} failed: ${safeText(message)}`, EXIT_RUNTIME_ERROR);
}

/** Judged before the prompt, so nobody is asked about a file that is refused anyway. */
async function inspect(backupPath: string, file: string): Promise<BackupInfo> {
  try {
    return await inspectBackup(backupPath, dirname(backupPath));
  } catch (error) {
    throw toCommandError(error, file, 'restore');
  }
}

async function confirmReplacement(
  file: string,
  dbPath: string,
  info: BackupInfo,
  isConfirmed: boolean,
  json: boolean,
): Promise<void> {
  if (isConfirmed) return;
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw usageError(
      'restore replaces the database; pass --yes to confirm when not running in a terminal',
    );
  }
  const message =
    `Replace ${safeText(dbPath)} with ${safeText(file)} (${info.entries} entries, schema ` +
    `${info.schemaVersion})? The current database is kept as backups/pre-restore-<time>.db. ` +
    'Close VS Code and `vault watch` first.';
  const accepted = await confirm({ message, default: false });
  if (!accepted) throw new CommandError('restore cancelled', EXIT_RUNTIME_ERROR);
}

async function restore(dbPath: string, backupPath: string, file: string): Promise<RestoreResult> {
  try {
    return await restoreVault(dbPath, backupPath);
  } catch (error) {
    throw toCommandError(error, file, 'restore');
  }
}

function report(result: RestoreResult, file: string, json: boolean): void {
  const { entries, schemaVersion } = result.info;
  if (json) {
    jsonOutput({ restored: { file, entries, schemaVersion }, preRestore: result.preRestore });
    return;
  }
  console.log(
    chalk.green(
      `\nDatabase restored from: ${safeText(file)} (${entries} entries, schema ${schemaVersion})`,
    ),
  );
  console.log(`The previous database is kept as ${safeText(result.preRestore)}`);
  console.log(chalk.dim('Run `vault list` to verify.\n'));
}
