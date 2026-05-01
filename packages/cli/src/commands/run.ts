import { Command } from 'commander';
import chalk from 'chalk';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';

export function createRunCommand(): Command {
  const cmd = new Command('run')
    .alias('r')
    .description('Get the slash command for an entry')
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
        const slashCommand = vault.getSlashCommand(entry);

        if (globalOpts.json) {
          console.log(JSON.stringify({ name: entry.name, command: slashCommand }));
        } else {
          console.log(slashCommand);
        }

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
