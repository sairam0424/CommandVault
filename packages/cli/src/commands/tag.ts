import { Command } from 'commander';
import chalk from 'chalk';
import { createVaultInstance, typeEmoji, typeColor, type CliGlobalOptions } from '../helpers.js';

export function createTagCommand(): Command {
  const cmd = new Command('tag')
    .description('Manage user-defined tags on vault entries')
    .argument('<action>', 'Action to perform (add|remove|list)')
    .argument('<name>', 'Entry name (fuzzy matched)')
    .argument('[tag]', 'Tag to add or remove')
    .action(
      async (
        action: string,
        name: string,
        tag: string | undefined,
        _opts: unknown,
        command: Command,
      ) => {
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

          switch (action) {
            case 'add': {
              if (!tag) {
                console.log(chalk.red('\nUsage: vault tag add <name> <tag>\n'));
                return;
              }
              vault.addTag(entry.id, tag);
              console.log('');
              console.log(
                `  ${chalk.green('+')} Added tag ${chalk.bold(tag)} to ${colorFn(chalk.bold(entry.name))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}`,
              );
              console.log('');
              break;
            }

            case 'remove': {
              if (!tag) {
                console.log(chalk.red('\nUsage: vault tag remove <name> <tag>\n'));
                return;
              }
              vault.removeTag(entry.id, tag);
              console.log('');
              console.log(
                `  ${chalk.red('-')} Removed tag ${chalk.bold(tag)} from ${colorFn(chalk.bold(entry.name))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}`,
              );
              console.log('');
              break;
            }

            case 'list': {
              const updatedEntry = vault.getEntry(entry.id);
              const tags = updatedEntry?.tags ?? entry.tags;
              const userTags = vault.getTagsForEntry(entry.id);
              const userTagSet = new Set(userTags);

              console.log('');
              console.log(
                `  Tags for ${colorFn(chalk.bold(entry.name))} ${chalk.dim(`(${typeEmoji(entry.type)} ${entry.type})`)}:`,
              );
              console.log('');

              if (tags.length === 0) {
                console.log(chalk.dim('    No tags'));
              } else {
                for (const t of tags) {
                  const label = userTagSet.has(t) ? chalk.cyan('[user]') : chalk.dim('[parsed]');
                  console.log(`    ${label} ${t}`);
                }
              }
              console.log('');
              break;
            }

            default: {
              console.log(chalk.red(`\nUnknown action "${action}". Use: add, remove, or list\n`));
            }
          }
        } finally {
          await vault.dispose();
        }
      },
    );

  return cmd;
}
