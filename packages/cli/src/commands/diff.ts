import { Command } from 'commander';
import chalk from 'chalk';
import { createVaultInstance, typeEmoji, type CliGlobalOptions } from '../helpers.js';

export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Show what changed since the last scan snapshot')
    .action(async (_opts: unknown, command: Command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const vault = await createVaultInstance(globalOpts);

      try {
        const entries = vault.getAllEntries();
        const diff = vault.getDiff();

        const hasSnapshot = diff.added.length !== entries.length || diff.removed.length > 0 || diff.modified.length > 0;

        if (!hasSnapshot) {
          vault.saveSnapshot();
          console.log(chalk.cyan('\nBaseline snapshot saved.\n'));
          console.log(chalk.dim(`  ${entries.length} entries recorded. Run "vault diff" again to see changes.\n`));
          return;
        }

        const totalChanges = diff.added.length + diff.removed.length + diff.modified.length;

        if (totalChanges === 0) {
          console.log(chalk.green('\nNo changes since last snapshot.\n'));
          vault.saveSnapshot();
          return;
        }

        console.log('');
        console.log(chalk.bold('Changes since last snapshot:'));
        console.log('');

        for (const entry of diff.added) {
          console.log(chalk.green(`  + ${entry.name} (${typeEmoji(entry.type)} ${entry.type})`));
        }

        for (const name of diff.removed) {
          console.log(chalk.red(`  - ${name}`));
        }

        for (const entry of diff.modified) {
          console.log(chalk.yellow(`  ~ ${entry.name} (${typeEmoji(entry.type)} ${entry.type})`));
        }

        console.log('');
        console.log(
          chalk.dim(
            `  ${chalk.green(`${diff.added.length} added`)}, ` +
            `${chalk.red(`${diff.removed.length} removed`)}, ` +
            `${chalk.yellow(`${diff.modified.length} modified`)}`
          )
        );
        console.log('');

        vault.saveSnapshot();
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
