import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';

export function createOpenCommand(): Command {
  const cmd = new Command('open')
    .alias('o')
    .description('Open an entry source file in your editor')
    .argument('<name>', 'Entry name (fuzzy matched)')
    .action(async (name: string, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const vault = await createVaultInstance(globalOpts);

      try {
        const results = vault.quickSearch(name, 1);

        if (results.length === 0) {
          console.log(chalk.yellow(`\nNo entry found matching "${name}".\n`));
          return;
        }

        const entry = results[0].entry;
        const editor = process.env.EDITOR || 'code';

        const resolvedPath = resolve(entry.filePath);
        try {
          accessSync(resolvedPath, constants.R_OK);
        } catch {
          console.log(chalk.red(`\nFile not found or not readable: ${entry.filePath}`));
          return;
        }

        console.log(chalk.dim(`\nOpening ${entry.name} in ${editor}...`));

        try {
          execFileSync(editor, [resolvedPath], { stdio: 'inherit' });
        } catch {
          console.log(chalk.red(`Failed to open editor (${editor}). Set $EDITOR to override.`));
        }

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
