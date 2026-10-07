import { Command } from 'commander';
import chalk from 'chalk';
import { getParseSeverity, importFromUrl } from '@commandvault/core';
import {
  createVaultInstance,
  headlineProblem,
  printParseProblems,
  type CliGlobalOptions,
} from '../helpers.js';
import { createSpinner } from '../ui/spinner.js';
import { usageError, CommandError } from '../errors.js';
import { safeText, toDisplay } from '../ui/safe-text.js';

export function createSyncCommand(): Command {
  const cmd = new Command('sync')
    .description('Sync commands from a remote registry URL')
    .argument('<url>', 'URL to a .vault.json registry')
    .option('--dry-run', 'Preview without saving')
    .action(async (url: string, opts: { dryRun?: boolean }, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw usageError(
          'URL must start with http:// or https://',
          'for local files, use: vault import <file>',
        );
      }

      const spinner = globalOpts.json ? null : createSpinner(`Fetching from ${url}...`).start();
      const result = await importFromUrl(url);

      const failed = result.errors.some((problem) => getParseSeverity(problem) === 'error');
      if (failed) {
        spinner?.stop();
        throw new CommandError(safeText(headlineProblem(result.errors)?.message ?? 'sync failed'));
      }

      spinner?.succeed(`Fetched ${result.entries.length} entries from remote`);
      printParseProblems(result.errors);

      if (result.entries.length === 0) {
        console.log(chalk.yellow('No entries found at remote URL.'));
        return;
      }

      console.log(chalk.gray('\nEntries:'));
      // Remote records: every field, the type and source included, is an open string at runtime.
      for (const view of result.entries.slice(0, 10).map(toDisplay)) {
        console.log(`  ${chalk.cyan(view.name)} — ${view.description.slice(0, 60)}`);
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
