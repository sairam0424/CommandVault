import { Command } from 'commander';
import chalk from 'chalk';
import type { EntryType, VaultStats } from '@commandvault/core';
import {
  createVaultInstance,
  typeEmoji,
  typeColor,
  formatDate,
  type CliGlobalOptions,
} from '../helpers.js';

const TYPE_ORDER: readonly EntryType[] = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'];

const BAR_CHARS = [' ', '█'];
const MAX_BAR_WIDTH = 30;

function renderBar(count: number, maxCount: number): string {
  if (maxCount === 0) {
    return '';
  }

  const filled = Math.round((count / maxCount) * MAX_BAR_WIDTH);
  const bar = BAR_CHARS[1].repeat(filled) + BAR_CHARS[0].repeat(MAX_BAR_WIDTH - filled);
  return bar;
}

export function createStatsCommand(): Command {
  const cmd = new Command('stats')
    .description('Show vault statistics dashboard')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      const vault = await createVaultInstance(globalOpts);

      try {
        const stats: VaultStats = vault.getStats();

        console.log('');
        console.log(chalk.bold.white('  CommandVault Dashboard'));
        console.log(chalk.dim('  ' + '='.repeat(40)));
        console.log('');
        console.log(
          `  ${chalk.dim('Total entries:')}  ${chalk.bold.white(String(stats.totalEntries))}`,
        );
        console.log(
          `  ${chalk.dim('Favorites:')}     ${chalk.yellow(String(stats.favoriteCount))}`,
        );
        console.log(`  ${chalk.dim('Last scan:')}     ${formatDate(stats.lastScanAt)}`);

        // Breakdown by type
        console.log('');
        console.log(chalk.bold.white('  Entries by Type'));
        console.log(chalk.dim('  ' + '-'.repeat(40)));

        const maxTypeCount = Math.max(...TYPE_ORDER.map((t) => stats.byType[t] ?? 0), 1);

        for (const type of TYPE_ORDER) {
          const count = stats.byType[type] ?? 0;
          const colorFn = typeColor(type);
          const bar = renderBar(count, maxTypeCount);
          const label = `${typeEmoji(type)} ${type.padEnd(8)}`;
          console.log(`  ${colorFn(label)} ${colorFn(bar)} ${chalk.bold(String(count))}`);
        }

        // Breakdown by source
        console.log('');
        console.log(chalk.bold.white('  Entries by Source'));
        console.log(chalk.dim('  ' + '-'.repeat(40)));

        const sourceEntries = Object.entries(stats.bySource)
          .filter(([, count]) => count > 0)
          .sort(([, a], [, b]) => b - a);

        const maxSourceCount =
          sourceEntries.length > 0 ? Math.max(...sourceEntries.map(([, c]) => c), 1) : 1;

        for (const [source, count] of sourceEntries) {
          const bar = renderBar(count, maxSourceCount);
          console.log(
            `  ${chalk.white(source.padEnd(14))} ${chalk.blue(bar)} ${chalk.bold(String(count))}`,
          );
        }

        if (sourceEntries.length === 0) {
          console.log(chalk.dim('  (no entries)'));
        }

        // Top 10 most used
        console.log('');
        console.log(chalk.bold.white('  Top 10 Most Used'));
        console.log(chalk.dim('  ' + '-'.repeat(40)));

        const allEntries = vault.getAllEntries();
        const topUsed = [...allEntries]
          .filter((e) => e.usageCount > 0)
          .sort((a, b) => b.usageCount - a.usageCount)
          .slice(0, 10);

        if (topUsed.length === 0) {
          console.log(chalk.dim('  No usage data yet. Use `vault info <name>` to start tracking.'));
        } else {
          for (const [index, entry] of topUsed.entries()) {
            const colorFn = typeColor(entry.type);
            const rank = chalk.dim(`${(index + 1).toString().padStart(2)}.`);
            const uses = chalk.bold(`${entry.usageCount}x`);
            console.log(`  ${rank} ${colorFn(entry.name.padEnd(30))} ${uses}`);
          }
        }

        console.log('');
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
