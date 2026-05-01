import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import type { VaultEntry, EntryType, EntrySource } from '@commandvault/core';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';

interface ExportPayload {
  readonly exportedAt: string;
  readonly totalEntries: number;
  readonly filters: {
    readonly type?: string;
    readonly source?: string;
  };
  readonly entries: readonly VaultEntry[];
}

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

        const payload: ExportPayload = {
          exportedAt: new Date().toISOString(),
          totalEntries: entries.length,
          filters: {
            ...(opts.type ? { type: opts.type } : {}),
            ...(opts.source ? { source: opts.source } : {}),
          },
          entries,
        };

        const json = opts.pretty
          ? JSON.stringify(payload, null, 2)
          : JSON.stringify(payload);

        const resolvedPath = resolve(outputPath);
        const writeSpinner = ora('Writing export file...').start();

        await writeFile(resolvedPath, json, 'utf-8');

        writeSpinner.succeed(`Exported ${entries.length} entries to ${chalk.underline(resolvedPath)}`);
        console.log(chalk.dim(`  Size: ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB\n`));
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
