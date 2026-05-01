import { Command } from 'commander';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import type { VaultEntry, EntryType, EntrySource } from '@commandvault/core';
import { exportToFile } from '@commandvault/core';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';

export function createExportCommand(): Command {
  const cmd = new Command('export')
    .description('Export vault entries to JSON')
    .argument('[output-path]', 'Output file path', './commandvault-export.json')
    .option('-t, --type <type>', 'Filter by entry type')
    .option('-s, --source <source>', 'Filter by source')
    .option('-p, --pretty', 'Pretty-print JSON output')
    .action(async (outputPath: string, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const opts = command.opts();

      const vault = await createVaultInstance(globalOpts);

      try {
        let entries: readonly VaultEntry[] = vault.getAllEntries();

        if (opts.type) {
          entries = entries.filter((e) => e.type === (opts.type as EntryType));
        }

        if (opts.source) {
          entries = entries.filter((e) => e.source === (opts.source as EntrySource));
        }

        const resolvedPath = resolve(outputPath);
        const writeSpinner = ora('Writing export file...').start();

        const sourceName = [
          'commandvault-cli',
          ...(opts.type ? [`type:${opts.type}`] : []),
          ...(opts.source ? [`source:${opts.source}`] : []),
        ].join('/');

        const count = await exportToFile(entries, resolvedPath, sourceName, !!opts.pretty);

        const fileStats = await stat(resolvedPath);
        writeSpinner.succeed(`Exported ${count} entries to ${chalk.underline(resolvedPath)}`);
        console.log(chalk.dim(`  Size: ${(fileStats.size / 1024).toFixed(1)} KB\n`));
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
