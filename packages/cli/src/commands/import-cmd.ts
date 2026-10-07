import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { importFromFile, importFromUrl } from '@commandvault/core';
import {
  createVaultInstance,
  headlineProblem,
  printParseProblems,
  typeEmoji,
  typeColor,
  type CliGlobalOptions,
} from '../helpers.js';
import { createSpinner } from '../ui/spinner.js';
import { CommandError } from '../errors.js';
import { safeText, toDisplay } from '../ui/safe-text.js';

export function createImportCommand(): Command {
  const cmd = new Command('import')
    .description('Import commands from a .vault.json file or URL')
    .argument('<source>', 'Path to .vault.json file or URL')
    .option('--dry-run', 'Preview what would be imported without saving')
    .action(async (source: string, opts: { dryRun?: boolean }, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      const spinner = globalOpts.json ? null : createSpinner('Importing entries...').start();

      const isUrl = source.startsWith('http://') || source.startsWith('https://');
      const result = isUrl ? await importFromUrl(source) : await importFromFile(source);

      if (result.entries.length === 0) {
        spinner?.stop();
        const headline = headlineProblem(result.errors);
        const reason = headline ? ` (${safeText(headline.message)})` : '';
        throw new CommandError(`no valid entries found in source${reason}`);
      }

      spinner?.succeed(`Found ${result.entries.length} entries to import`);
      printParseProblems(result.errors);

      const table = new Table({
        // No head/border colours: @colors/colors ignores isTTY and NO_COLOR (see list.ts).
        style: { head: [], border: [] },
        head: [
          chalk.gray('Type'),
          chalk.gray('Name'),
          chalk.gray('Source'),
          chalk.gray('Description'),
        ],
        colWidths: [8, 30, 12, 50],
        wordWrap: true,
      });

      // Bundle records: every field, the type and source included, is an open string at runtime.
      for (const view of result.entries.map(toDisplay)) {
        const colorFn = typeColor(view.type);
        table.push([
          typeEmoji(view.type),
          colorFn(view.name),
          view.source,
          view.description.slice(0, 47) + (view.description.length > 47 ? '...' : ''),
        ]);
      }

      console.log(table.toString());

      if (opts.dryRun) {
        console.log(chalk.yellow('\nDry run — nothing was saved. Remove --dry-run to import.'));
        return;
      }

      const vault = await createVaultInstance(globalOpts);
      try {
        await vault.addEntries(result.entries);
        console.log(chalk.green(`\n✓ Imported ${result.entries.length} entries`));
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
