import { Command } from 'commander';
import {
  COMPACT_JSON,
  createVaultInstance,
  jsonOutput,
  type CliGlobalOptions,
} from '../helpers.js';
import { CommandError } from '../errors.js';
import { safeText } from '../ui/safe-text.js';

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
          throw new CommandError(`no entry found matching "${name}"`);
        }

        const entry = results[0].entry;

        if (globalOpts.json) {
          jsonOutput({ name: entry.name, command: vault.getSlashCommand(entry) }, COMPACT_JSON);
        } else {
          console.log(safeText(vault.getSlashCommand(entry)));
        }

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
