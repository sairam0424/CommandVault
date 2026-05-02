import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { importFromFile, importFromUrl } from '@commandvault/core';
import { createVaultInstance, typeEmoji, typeColor, type CliGlobalOptions } from '../helpers.js';

export function createImportCommand(): Command {
  const cmd = new Command('import')
    .description('Import commands from a .vault.json file or URL')
    .argument('<source>', 'Path to .vault.json file or URL')
    .option('--dry-run', 'Preview what would be imported without saving')
    .action(async (source: string, opts: { dryRun?: boolean }, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      const spinner = globalOpts.json ? null : ora('Importing entries...').start();

      const isUrl = source.startsWith('http://') || source.startsWith('https://');
      const result = isUrl ? await importFromUrl(source) : await importFromFile(source);

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          spinner?.warn(chalk.yellow(`Warning: ${err.message}`));
        }
      }

      if (result.entries.length === 0) {
        spinner?.fail('No valid entries found in source');
        return;
      }

      spinner?.succeed(`Found ${result.entries.length} entries to import`);

      const table = new Table({
        head: [
          chalk.gray('Type'),
          chalk.gray('Name'),
          chalk.gray('Source'),
          chalk.gray('Description'),
        ],
        colWidths: [8, 30, 12, 50],
        wordWrap: true,
      });

      for (const entry of result.entries) {
        const colorFn = typeColor(entry.type);
        table.push([
          typeEmoji(entry.type),
          colorFn(entry.name),
          entry.source,
          entry.description.slice(0, 47) + (entry.description.length > 47 ? '...' : ''),
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
