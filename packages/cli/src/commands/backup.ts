import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { backupDirPath, dbFilePath } from '../config.js';
import { CommandError, EXIT_RUNTIME_ERROR } from '../errors.js';

const MAX_BACKUPS = 10;

export function createBackupCommand(): Command {
  const cmd = new Command('backup')
    .description('Backup the vault database')
    .option('--list', 'List available backups')
    .action(async (opts) => {
      if (opts.list) {
        await listBackups();
        return;
      }

      const backupDir = backupDirPath();
      await mkdir(backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = join(backupDir, `vault-${timestamp}.db`);

      try {
        await copyFile(dbFilePath(), backupPath);
        console.log(chalk.green(`\nBackup created: ${backupPath}\n`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CommandError(
          `backup failed: ${message}`,
          EXIT_RUNTIME_ERROR,
          'run `vault list` first to create the database',
        );
      }

      await pruneBackups();
    });

  return cmd;
}

async function listBackups(): Promise<void> {
  const backupDir = backupDirPath();
  try {
    const files = await readdir(backupDir);
    const backups = files
      .filter((f) => f.startsWith('vault-') && f.endsWith('.db'))
      .sort()
      .reverse();

    if (backups.length === 0) {
      console.log(chalk.yellow('\nNo backups found. Run `vault backup` to create one.\n'));
      return;
    }

    console.log(chalk.bold('\n  Available backups:\n'));
    for (const backup of backups) {
      const fullPath = join(backupDir, backup);
      const stats = await stat(fullPath);
      const size = (stats.size / 1024).toFixed(1);
      console.log(`  ${chalk.cyan(backup)}  ${chalk.dim(`${size} KB`)}`);
    }
    console.log('');
  } catch {
    console.log(chalk.yellow('\nNo backups directory found.\n'));
  }
}

async function pruneBackups(): Promise<void> {
  const backupDir = backupDirPath();
  try {
    const files = await readdir(backupDir);
    const backups = files.filter((f) => f.startsWith('vault-') && f.endsWith('.db')).sort();

    if (backups.length <= MAX_BACKUPS) return;

    const { unlink } = await import('node:fs/promises');
    const toRemove = backups.slice(0, backups.length - MAX_BACKUPS);
    for (const file of toRemove) {
      await unlink(join(backupDir, file));
    }

    if (toRemove.length > 0) {
      console.log(
        chalk.dim(`Pruned ${toRemove.length} old backup(s) (keeping last ${MAX_BACKUPS})`),
      );
    }
  } catch {
    // ignore prune errors
  }
}
