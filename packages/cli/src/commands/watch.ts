import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createVault, type VaultEntry, type SearchTier } from '@commandvault/core';
import type { CliGlobalOptions } from '../helpers.js';

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function createWatchCommand(): Command {
  const cmd = new Command('watch')
    .description('Live mode — print file changes as they happen')
    .action(async (_opts: unknown, command: Command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      const spinner = globalOpts.json ? null : ora('Initializing vault in watch mode...').start();

      const vault = createVault({
        claudeConfigPath: globalOpts.claudePath,
        defaultSearchTier: globalOpts.tier as SearchTier | undefined,
        enableWatcher: true,
      });

      try {
        const stats = await vault.initialize();
        spinner?.succeed(`Vault loaded: ${stats.totalEntries} entries indexed`);
      } catch (error) {
        spinner?.fail('Failed to initialize vault');
        throw error;
      }

      vault.on('entry:added', (entry: VaultEntry) => {
        console.log(
          chalk.dim(`[${timestamp()}]`) + chalk.green(` + ${entry.type}: ${entry.name} (added)`),
        );
      });

      vault.on('entry:updated', (entry: VaultEntry) => {
        console.log(
          chalk.dim(`[${timestamp()}]`) + chalk.yellow(` ~ ${entry.type}: ${entry.name} (updated)`),
        );
      });

      vault.on('entry:removed', (id: string) => {
        console.log(chalk.dim(`[${timestamp()}]`) + chalk.red(` - ${id} (removed)`));
      });

      console.log('');
      console.log(chalk.cyan('Watching for changes... (Ctrl+C to stop)'));
      console.log('');

      const cleanup = async () => {
        console.log('');
        console.log(chalk.dim('Stopping watcher...'));
        await vault.dispose();
        process.exit(0);
      };

      process.on('SIGINT', () => {
        cleanup().catch(() => process.exit(1));
      });

      process.on('SIGTERM', () => {
        cleanup().catch(() => process.exit(1));
      });

      // Keep the process alive
      await new Promise<never>(() => {});
    });

  return cmd;
}
