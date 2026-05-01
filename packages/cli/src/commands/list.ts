import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { VaultEntry, EntryType } from '@commandvault/core';
import {
  createVaultInstance,
  typeEmoji,
  typeColor,
  truncate,
  type CliGlobalOptions,
} from '../helpers.js';

const TYPE_ORDER: readonly EntryType[] = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'];

const TYPE_LABELS: Readonly<Record<EntryType, string>> = {
  skill: 'SKL',
  agent: 'AGT',
  command: 'CMD',
  plugin: 'PLG',
  rule: 'RUL',
  hook: 'HK',
};

function buildTable(): InstanceType<typeof Table> {
  return new Table({
    style: { compact: true, 'padding-left': 1, 'padding-right': 1 },
    head: [chalk.gray('Type'), chalk.gray('Name'), chalk.gray('Source'), chalk.gray('Description')],
  });
}

function formatTypeCell(type: EntryType): string {
  const colorFn = typeColor(type);
  return colorFn(`${typeEmoji(type)} ${TYPE_LABELS[type]}`);
}

function entryToRow(entry: VaultEntry): string[] {
  const colorFn = typeColor(entry.type);
  return [
    formatTypeCell(entry.type),
    colorFn(entry.name),
    chalk.dim(entry.source),
    truncate(entry.description || chalk.dim('(no description)'), 50),
  ];
}

export function createListCommand(): Command {
  const cmd = new Command('list')
    .alias('ls')
    .description('List all entries in the vault')
    .option('-t, --type <type>', 'Filter by entry type (skill|agent|command|plugin|rule|hook)')
    .option('-s, --source <source>', 'Filter by source')
    .option('--tag <tag>', 'Filter by tag')
    .option('-f, --favorites', 'Show only favorites')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const opts = command.opts();

      const vault = await createVaultInstance(globalOpts);

      try {
        let entries: readonly VaultEntry[] = vault.getAllEntries();

        if (opts.type) {
          entries = entries.filter((e) => e.type === opts.type);
        }

        if (opts.source) {
          entries = entries.filter((e) => e.source === opts.source);
        }

        if (opts.tag) {
          const tag = opts.tag.toLowerCase();
          entries = entries.filter((e) => e.tags.some((t) => t.toLowerCase() === tag));
        }

        if (opts.favorites) {
          entries = entries.filter((e) => e.favorite);
        }

        if (globalOpts.json) {
          console.log(JSON.stringify({ entries }, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log(chalk.yellow('\nNo entries found matching your filters.\n'));
          return;
        }

        const hasFilter = opts.type || opts.source || opts.tag || opts.favorites;

        if (hasFilter) {
          const table = buildTable();
          for (const entry of entries) {
            table.push(entryToRow(entry));
          }
          console.log(`\n${table.toString()}`);
        } else {
          for (const type of TYPE_ORDER) {
            const group = entries.filter((e) => e.type === type);
            if (group.length === 0) {
              continue;
            }

            const colorFn = typeColor(type);
            console.log(
              `\n${colorFn(chalk.bold(`${typeEmoji(type)}  ${type.toUpperCase()}S (${group.length})`))}`,
            );

            const table = buildTable();
            for (const entry of group) {
              table.push(entryToRow(entry));
            }
            console.log(table.toString());
          }
        }

        console.log(chalk.dim(`\nTotal: ${entries.length} entries\n`));
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
