import { Command } from 'commander';
import chalk from 'chalk';
import type { VaultEntry } from '@commandvault/core';
import {
  createVaultInstance,
  typeEmoji,
  typeColor,
  formatDate,
  type CliGlobalOptions,
} from '../helpers.js';

function drawBox(title: string, lines: readonly string[]): string {
  const maxLen = Math.max(title.length + 4, ...lines.map((l) => stripAnsi(l).length + 4));
  const width = Math.min(Math.max(maxLen, 40), 80);

  const top = `┌${''.padEnd(width, '─')}┐`;
  const titleLine = `│ ${chalk.bold(title)}${''.padEnd(width - stripAnsi(title).length - 2)}│`;
  const separator = `├${''.padEnd(width, '─')}┤`;
  const bottom = `└${''.padEnd(width, '─')}┘`;

  const contentLines = lines.map((line) => {
    const stripped = stripAnsi(line);
    const padding = width - stripped.length - 2;
    return `│ ${line}${''.padEnd(Math.max(padding, 0))}│`;
  });

  return [top, titleLine, separator, ...contentLines, bottom].join('\n');
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function formatMetadata(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return [chalk.dim('(none)')];
  }

  return entries.map(([key, value]) => {
    const formatted = typeof value === 'string' ? value : JSON.stringify(value);
    return `${chalk.cyan(key)}: ${formatted}`;
  });
}

export function createInfoCommand(): Command {
  const cmd = new Command('info')
    .alias('nfo')
    .description('Show detailed info about an entry')
    .argument('<name>', 'Entry name (fuzzy matched)')
    .action(async (name: string, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      const vault = await createVaultInstance(globalOpts);

      try {
        const results = vault.quickSearch(name, 1);

        if (results.length === 0) {
          if (globalOpts.json) {
            console.log(JSON.stringify({ entry: null }, null, 2));
          } else {
            console.log(chalk.yellow(`\nNo entry found matching "${name}".\n`));
          }
          return;
        }

        const entry: VaultEntry = results[0].entry;

        if (globalOpts.json) {
          console.log(
            JSON.stringify({ entry, slashCommand: vault.getSlashCommand(entry) }, null, 2),
          );
          vault.recordUsage(entry.id);
          return;
        }

        const colorFn = typeColor(entry.type);
        const slashCommand = vault.getSlashCommand(entry);

        const lines: string[] = [
          '',
          `${chalk.dim('Type:')}       ${colorFn(`${typeEmoji(entry.type)} ${entry.type}`)}`,
          `${chalk.dim('Source:')}     ${entry.source}`,
          `${chalk.dim('Command:')}    ${chalk.bold(slashCommand)}`,
          '',
          `${chalk.dim('Description:')}`,
          `  ${entry.description || chalk.dim('(no description)')}`,
          '',
          `${chalk.dim('Tags:')}       ${entry.tags.length > 0 ? entry.tags.map((t) => chalk.cyan(`#${t}`)).join(' ') : chalk.dim('(none)')}`,
          `${chalk.dim('File:')}       ${chalk.underline(entry.filePath)}`,
          '',
          `${chalk.dim('Metadata:')}`,
          ...formatMetadata(entry.metadata).map((l) => `  ${l}`),
          '',
          `${chalk.dim('Modified:')}   ${formatDate(entry.lastModified)}`,
          `${chalk.dim('Usage:')}      ${entry.usageCount} time${entry.usageCount === 1 ? '' : 's'}`,
          `${chalk.dim('Favorite:')}   ${entry.favorite ? chalk.yellow('★ Yes') : chalk.dim('☆ No')}`,
          '',
        ];

        const title = `${typeEmoji(entry.type)} ${colorFn(entry.name)}`;
        console.log(`\n${drawBox(title, lines)}\n`);

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
