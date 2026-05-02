import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { importFromUrl } from '@commandvault/core';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';

export function createSyncCommand(): Command {
  const cmd = new Command('sync')
    .description('Sync commands from a remote registry URL')
    .argument('<url>', 'URL to a .vault.json registry')
    .option('--dry-run', 'Preview without saving')
    .action(async (url: string, opts: { dryRun?: boolean }, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        console.error(chalk.red('Error: URL must start with http:// or https://'));
        console.log(chalk.gray('For local files, use: vault import <file>'));
        process.exit(1);
      }

      const spinner = globalOpts.json ? null : ora(`Fetching from ${url}...`).start();
      const result = await importFromUrl(url);

      if (result.errors.length > 0) {
        spinner?.fail(chalk.red(result.errors[0].message));
        return;
      }

      spinner?.succeed(`Fetched ${result.entries.length} entries from remote`);

      if (result.entries.length === 0) {
        console.log(chalk.yellow('No entries found at remote URL.'));
        return;
      }

      console.log(chalk.gray('\nEntries:'));
      for (const entry of result.entries.slice(0, 10)) {
        console.log(`  ${chalk.cyan(entry.name)} — ${entry.description.slice(0, 60)}`);
      }
      if (result.entries.length > 10) {
        console.log(chalk.gray(`  ... and ${result.entries.length - 10} more`));
      }

      if (opts.dryRun) {
        console.log(chalk.yellow('\nDry run — nothing was saved.'));
        return;
      }

      const vault = await createVaultInstance(globalOpts);
      try {
        await vault.addEntries(result.entries);
        console.log(chalk.green(`\n✓ Synced ${result.entries.length} entries from remote`));
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
