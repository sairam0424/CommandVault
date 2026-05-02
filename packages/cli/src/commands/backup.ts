import { Command } from 'commander';
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';

const DB_PATH = join(homedir(), '.commandvault', 'vault.db');
const BACKUP_DIR = join(homedir(), '.commandvault', 'backups');
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

      await mkdir(BACKUP_DIR, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = join(BACKUP_DIR, `vault-${timestamp}.db`);

      try {
        await copyFile(DB_PATH, backupPath);
        console.log(chalk.green(`\nBackup created: ${backupPath}\n`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\nBackup failed: ${message}`));
        console.log(chalk.yellow('Run `vault list` first to create the database.\n'));
        return;
      }

      await pruneBackups();
    });

  return cmd;
}

async function listBackups(): Promise<void> {
  try {
    const files = await readdir(BACKUP_DIR);
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
      const fullPath = join(BACKUP_DIR, backup);
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
  try {
    const files = await readdir(BACKUP_DIR);
    const backups = files.filter((f) => f.startsWith('vault-') && f.endsWith('.db')).sort();

    if (backups.length <= MAX_BACKUPS) return;

    const { unlink } = await import('node:fs/promises');
    const toRemove = backups.slice(0, backups.length - MAX_BACKUPS);
    for (const file of toRemove) {
      await unlink(join(BACKUP_DIR, file));
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
