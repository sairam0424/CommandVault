import { Command } from 'commander';
import chalk from 'chalk';
import type { EntryType } from '@commandvault/core';
import { createVaultInstance, typeEmoji, typeColor, type CliGlobalOptions } from '../helpers.js';
import { CommandError, invalidChoiceError, usageError } from '../errors.js';

const VALID_TYPES = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'] as const;

export function createFavoriteCommand(): Command {
  const cmd = new Command('favorite')
    .alias('fav')
    .description('Toggle favorite status on an entry (or bulk with --type)')
    .argument('[name]', 'Entry name (fuzzy matched)')
    .option('--type <type>', 'Apply to all entries of this type (bulk operation)')
    .action(async (name: string | undefined, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const opts = command.opts();

      const vault = await createVaultInstance(globalOpts);

      try {
        // Bulk mode: toggle favorites for all entries of a given type
        if (opts.type) {
          if (!VALID_TYPES.includes(opts.type as any)) {
            throw invalidChoiceError('--type', opts.type, VALID_TYPES);
          }

          const allEntries = vault.getAllEntries();
          const filtered = allEntries.filter((e) => e.type === (opts.type as EntryType));

          if (filtered.length === 0) {
            throw new CommandError(`no entries found of type "${opts.type}"`);
          }

          let favorited = 0;
          let unfavorited = 0;
          for (const entry of filtered) {
            const isFav = vault.toggleFavorite(entry.id);
            if (isFav) {
              favorited++;
            } else {
              unfavorited++;
            }
          }

          console.log('');
          console.log(
            `  Toggled ${chalk.bold(String(filtered.length))} ${opts.type} entries: ${chalk.yellow(`${favorited} favorited`)}, ${chalk.dim(`${unfavorited} unfavorited`)}`,
          );
          console.log('');
          return;
        }

        // Single entry mode
        if (!name) {
          throw usageError('usage: vault favorite <name> or vault favorite --type <type>');
        }

        const results = vault.quickSearch(name, 1);

        if (results.length === 0) {
          throw new CommandError(`no entry found matching "${name}"`);
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
