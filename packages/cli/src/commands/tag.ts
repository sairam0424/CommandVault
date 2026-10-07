import { Command } from 'commander';
import chalk from 'chalk';
import type { EntryType } from '@commandvault/core';
import { createVaultInstance, typeEmoji, typeColor, type CliGlobalOptions } from '../helpers.js';
import { CommandError, invalidChoiceError, usageError } from '../errors.js';
import { safeText, toDisplay } from '../ui/safe-text.js';

const VALID_TYPES = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'] as const;

export function createTagCommand(): Command {
  const cmd = new Command('tag')
    .description('Manage user-defined tags on vault entries')
    .argument('<action>', 'Action to perform (add|remove|list)')
    .argument('[name]', 'Entry name (fuzzy matched)')
    .argument('[tag]', 'Tag to add or remove')
    .option('--type <type>', 'Apply to all entries of this type (bulk operation)')
    .action(
      async (
        action: string,
        name: string | undefined,
        tag: string | undefined,
        _opts: unknown,
        command: Command,
      ) => {
        const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
        const opts = command.opts();
        const vault = await createVaultInstance(globalOpts);

        try {
          // Bulk mode: apply tag operation to all entries of a given type
          if (opts.type) {
            if (!VALID_TYPES.includes(opts.type as any)) {
              throw invalidChoiceError('--type', opts.type, VALID_TYPES);
            }

            if (action !== 'add' && action !== 'remove') {
              throw usageError('bulk mode only supports "add" and "remove" actions');
            }

            // In bulk mode, if no name is given, the tag is the second positional arg (name position)
            const bulkTag = tag ?? name;
            if (!bulkTag) {
              throw usageError(`usage: vault tag ${action} <tag> --type <type>`);
            }

            const allEntries = vault.getAllEntries();
            const filtered = allEntries.filter((e) => e.type === (opts.type as EntryType));

            if (filtered.length === 0) {
              throw new CommandError(`no entries found of type "${opts.type}"`);
            }

            for (const entry of filtered) {
              if (action === 'add') {
                vault.addTag(entry.id, bulkTag);
              } else {
                vault.removeTag(entry.id, bulkTag);
              }
            }

            const verb = action === 'add' ? 'Added' : 'Removed';
            const symbol = action === 'add' ? chalk.green('+') : chalk.red('-');
            console.log('');
            console.log(
              `  ${symbol} ${verb} tag ${chalk.bold(bulkTag)} ${action === 'add' ? 'to' : 'from'} ${chalk.bold(String(filtered.length))} ${opts.type} entries`,
            );
            console.log('');
            return;
          }

          // Single entry mode requires name
          if (!name) {
            throw usageError(
              'usage: vault tag <action> <name> [tag] or vault tag <action> <tag> --type <type>',
            );
          }

          const results = vault.quickSearch(name, 1);

          if (results.length === 0) {
            throw new CommandError(`no entry found matching "${name}"`);
          }

          const entry = results[0].entry;
          const colorFn = typeColor(entry.type);

          switch (action) {
            case 'add': {
              if (!tag) {
                throw usageError('usage: vault tag add <name> <tag>');
              }
              vault.addTag(entry.id, tag);
              console.log('');
              console.log(
                `  ${chalk.green('+')} Added tag ${chalk.bold(tag)} to ${colorFn(chalk.bold(safeText(entry.name)))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}`,
              );
              console.log('');
              break;
            }

            case 'remove': {
              if (!tag) {
                throw usageError('usage: vault tag remove <name> <tag>');
              }
              vault.removeTag(entry.id, tag);
              console.log('');
              console.log(
                `  ${chalk.red('-')} Removed tag ${chalk.bold(tag)} from ${colorFn(chalk.bold(safeText(entry.name)))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}`,
              );
              console.log('');
              break;
            }

            case 'list': {
              const updatedEntry = vault.getEntry(entry.id);
              const view = toDisplay(updatedEntry ?? entry);
              // The user tags are cleaned the same way, so each shown tag finds its own label.
              const userTagSet = new Set(toDisplay(vault.getTagsForEntry(entry.id)));

              console.log('');
              console.log(
                `  Tags for ${colorFn(chalk.bold(view.name))} ${chalk.dim(`(${typeEmoji(view.type)} ${view.type})`)}:`,
              );
              console.log('');

              if (view.tags.length === 0) {
                console.log(chalk.dim('    No tags'));
              } else {
                for (const t of view.tags) {
                  const label = userTagSet.has(t) ? chalk.cyan('[user]') : chalk.dim('[parsed]');
                  console.log(`    ${label} ${t}`);
                }
              }
              console.log('');
              break;
            }

            default: {
              throw usageError(`unknown action "${action}" (expected add, remove or list)`);
            }
          }
        } finally {
          await vault.dispose();
        }
      },
    );

  return cmd;
}
