import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';
import { CommandError, EXIT_RUNTIME_ERROR } from '../errors.js';

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
        const editor = process.env.EDITOR || 'code';

        const resolvedPath = resolve(entry.filePath);
        try {
          accessSync(resolvedPath, constants.R_OK);
        } catch {
          throw new CommandError(`file not found or not readable: ${entry.filePath}`);
        }

        console.log(chalk.dim(`\nOpening ${entry.name} in ${editor}...`));

        try {
          execFileSync(editor, [resolvedPath], { stdio: 'inherit' });
        } catch {
          throw new CommandError(
            `failed to open editor (${editor})`,
            EXIT_RUNTIME_ERROR,
            'set $EDITOR to override',
          );
        }

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
