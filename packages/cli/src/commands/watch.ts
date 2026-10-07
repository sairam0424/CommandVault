import { Command } from 'commander';
import chalk from 'chalk';
import type { VaultEntry } from '@commandvault/core';
import { createConfiguredVault, type CliGlobalOptions } from '../helpers.js';
import { createSpinner } from '../ui/spinner.js';
import { onShutdown } from '../errors.js';
import { safeText } from '../ui/safe-text.js';

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

      // Before the spinner: a bad config.json fails here without printing "Initializing vault...".
      const vault = await createConfiguredVault(globalOpts, true);
      const spinner = globalOpts.json
        ? null
        : createSpinner('Initializing vault in watch mode...').start();

      try {
        const stats = await vault.initialize();
        spinner?.succeed(`Vault loaded: ${stats.totalEntries} entries indexed`);
      } catch (error) {
        spinner?.fail('Failed to initialize vault');
        throw error;
      }

      vault.on('entry:added', (entry: VaultEntry) => {
        console.log(
          chalk.dim(`[${timestamp()}]`) +
            chalk.green(` + ${entry.type}: ${safeText(entry.name)} (added)`),
        );
      });

      vault.on('entry:updated', (entry: VaultEntry) => {
        console.log(
          chalk.dim(`[${timestamp()}]`) +
            chalk.yellow(` ~ ${entry.type}: ${safeText(entry.name)} (updated)`),
        );
      });

      vault.on('entry:removed', (id: string) => {
        console.log(chalk.dim(`[${timestamp()}]`) + chalk.red(` - ${id} (removed)`));
      });

      console.log('');
      console.log(chalk.cyan('Watching for changes... (Ctrl+C to stop)'));
      console.log('');

      // The process-level SIGINT/SIGTERM handler runs this, then exits 130/143.
      onShutdown(async () => {
        console.error(chalk.dim('\nStopping watcher...'));
        await vault.dispose();
      });

      // Keep the process alive
      await new Promise<never>(() => {});
    });

  return cmd;
}
