import { Command } from 'commander';
import chalk from 'chalk';
import { join, basename } from 'node:path';
import { copyFile, access, constants } from 'node:fs/promises';
import { backupDirPath, dbFilePath } from '../config.js';
import { CommandError, EXIT_RUNTIME_ERROR, usageError } from '../errors.js';

export function createRestoreCommand(): Command {
  const cmd = new Command('restore')
    .description('Restore the vault database from a backup')
    .argument('<file>', 'Backup filename (from `vault backup --list`)')
    .action(async (file: string) => {
      const filename = basename(file);
      if (filename !== file) {
        throw usageError(
          'only backup filenames are allowed (no paths)',
          'run `vault backup --list` to see available backups',
        );
      }
      const backupPath = join(backupDirPath(), filename);

      try {
        await access(backupPath, constants.R_OK);
      } catch {
        throw new CommandError(
          `backup file not found: ${backupPath}`,
          EXIT_RUNTIME_ERROR,
          'run `vault backup --list` to see available backups',
        );
      }

      try {
        await copyFile(backupPath, dbFilePath());
        console.log(chalk.green(`\nDatabase restored from: ${backupPath}`));
        console.log(chalk.dim('Run `vault list` to verify.\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CommandError(`restore failed: ${message}`);
      }
    });

  return cmd;
}
