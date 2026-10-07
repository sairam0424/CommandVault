import { Command } from 'commander';
import chalk from 'chalk';
import type { VaultEntry } from '@commandvault/core';
import {
  createVaultInstance,
  typeEmoji,
  typeColor,
  formatDate,
  jsonOutput,
  type CliGlobalOptions,
} from '../helpers.js';
import { CommandError } from '../errors.js';
import { safeText, toDisplay } from '../ui/safe-text.js';

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
  // A parser records every field it looks for, so an absent one arrives as `undefined`.
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return [chalk.dim('(none)')];
  }

  return entries.map(([key, value]) => {
    const formatted = typeof value === 'string' ? safeText(value) : safeText(JSON.stringify(value));
    return `${chalk.cyan(safeText(key))}: ${formatted}`;
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
            jsonOutput({ entry: null });
          }
          throw new CommandError(`no entry found matching "${name}"`);
        }

        const entry: VaultEntry = results[0].entry;

        if (globalOpts.json) {
          jsonOutput({ entry, slashCommand: vault.getSlashCommand(entry) });
          vault.recordUsage(entry.id);
          return;
        }

        // Everything shown comes from the sanitised view, never from the entry itself.
        const view = toDisplay(entry);
        const colorFn = typeColor(view.type);
        const slashCommand = safeText(vault.getSlashCommand(entry));

        const lines: string[] = [
          '',
          `${chalk.dim('Type:')}       ${colorFn(`${typeEmoji(view.type)} ${view.type}`)}`,
          `${chalk.dim('Source:')}     ${view.source}`,
          `${chalk.dim('Command:')}    ${chalk.bold(slashCommand)}`,
          '',
          `${chalk.dim('Description:')}`,
          `  ${view.description || chalk.dim('(no description)')}`,
          '',
          `${chalk.dim('Tags:')}       ${view.tags.length > 0 ? view.tags.map((t) => chalk.cyan(`#${t}`)).join(' ') : chalk.dim('(none)')}`,
          `${chalk.dim('File:')}       ${chalk.underline(view.filePath)}`,
          '',
          `${chalk.dim('Metadata:')}`,
          ...formatMetadata(view.metadata).map((l) => `  ${l}`),
          '',
          `${chalk.dim('Modified:')}   ${formatDate(view.lastModified)}`,
          `${chalk.dim('Usage:')}      ${view.usageCount} time${view.usageCount === 1 ? '' : 's'}`,
          `${chalk.dim('Favorite:')}   ${view.favorite ? chalk.yellow('★ Yes') : chalk.dim('☆ No')}`,
          '',
        ];

        const title = `${typeEmoji(view.type)} ${colorFn(view.name)}`;
        console.log(`\n${drawBox(title, lines)}\n`);

        vault.recordUsage(entry.id);
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
