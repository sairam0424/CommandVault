import { Command } from 'commander';
import chalk from 'chalk';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';
import { CommandError } from '../errors.js';
import { openInEditor } from '../editor.js';
import { safeText } from '../ui/safe-text.js';

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
          throw new CommandError(`no entry found matching "${name}"`);
        }

        const entry = results[0].entry;
        // safe-text: the path is resolved and opened, not printed
        const resolvedPath = resolve(entry.filePath);
        try {
          accessSync(resolvedPath, constants.R_OK);
        } catch {
          throw new CommandError(`file not found or not readable: ${safeText(entry.filePath)}`);
        }

        console.log(chalk.dim(`\nOpening ${safeText(entry.name)}...`));
        openInEditor(resolvedPath);

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
