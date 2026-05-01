import { Command } from 'commander';
import chalk from 'chalk';
import { createVaultInstance, typeEmoji, typeColor, type CliGlobalOptions } from '../helpers.js';

export function createFavoriteCommand(): Command {
  const cmd = new Command('favorite')
    .alias('fav')
    .description('Toggle favorite status on an entry')
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
        const colorFn = typeColor(entry.type);

        const isFavorite = vault.toggleFavorite(entry.id);

        console.log('');
        if (isFavorite) {
          console.log(
            `  ${chalk.yellow('★')} Favorited ${colorFn(chalk.bold(entry.name))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}`,
          );
        } else {
          console.log(
            `  ${chalk.dim('☆')} Unfavorited ${colorFn(chalk.bold(entry.name))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}`,
          );
        }
        console.log('');
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
