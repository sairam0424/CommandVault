import { Command } from 'commander';
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFile, access, constants } from 'node:fs/promises';

const DB_PATH = join(homedir(), '.commandvault', 'vault.db');
const BACKUP_DIR = join(homedir(), '.commandvault', 'backups');

export function createRestoreCommand(): Command {
  const cmd = new Command('restore')
    .description('Restore the vault database from a backup')
    .argument('<file>', 'Backup filename (from `vault backup --list`)')
    .action(async (file: string) => {
      const backupPath = file.includes('/') ? file : join(BACKUP_DIR, file);

      try {
        await access(backupPath, constants.R_OK);
      } catch {
        console.log(chalk.red(`\nBackup file not found: ${backupPath}`));
        console.log(chalk.yellow('Run `vault backup --list` to see available backups.\n'));
        return;
      }

      try {
        await copyFile(backupPath, DB_PATH);
        console.log(chalk.green(`\nDatabase restored from: ${backupPath}`));
        console.log(chalk.dim('Run `vault list` to verify.\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\nRestore failed: ${message}\n`));
      }
    });

  return cmd;
}
