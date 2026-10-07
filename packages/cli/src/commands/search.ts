import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { SearchResult, EntryType, EntrySource } from '@commandvault/core';
import {
  withVault,
  typeEmoji,
  typeColor,
  truncate,
  jsonOutput,
  type CliGlobalOptions,
} from '../helpers.js';
import { usageError } from '../errors.js';
import { safeText } from '../ui/safe-text.js';

function highlightMatch(text: string, query: string): string {
  if (!query || !text) {
    return text;
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = text;

  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, chalk.bold.underline('$1'));
  }

  return result;
}

function formatScore(score: number): string {
  const normalized = Math.min(score, 1);
  if (normalized >= 0.8) {
    return chalk.green(`${(normalized * 100).toFixed(0)}%`);
  }
  if (normalized >= 0.5) {
    return chalk.yellow(`${(normalized * 100).toFixed(0)}%`);
  }
  return chalk.red(`${(normalized * 100).toFixed(0)}%`);
}

export function createSearchCommand(): Command {
  const cmd = new Command('search')
    .alias('s')
    .description('Search entries with fuzzy matching')
    .argument('<query>', 'Search query')
    .option('-t, --type <type>', 'Filter by entry type')
    .option('-s, --source <source>', 'Filter by source')
    .option('--tag <tag>', 'Filter results by tag')
    .option('-l, --limit <n>', 'Maximum results', '20')
    .action(async (query: string, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const opts = command.opts();

      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1 || limit > 1000) {
        throw usageError('--limit must be a number between 1 and 1000');
      }

      await withVault(globalOpts, async (vault) => {
        const results: readonly SearchResult[] = vault.search({
          query,
          type: opts.type as EntryType | undefined,
          source: opts.source as EntrySource | undefined,
          tags: opts.tag ? [opts.tag as string] : undefined,
          limit,
          tier: globalOpts.tier,
        });

        if (globalOpts.json) {
          jsonOutput({ query, results });
          return;
        }

        if (results.length === 0) {
          console.log(chalk.yellow(`\nNo results found for "${query}".\n`));
          return;
        }

        const table = new Table({
          // No head/border colours: @colors/colors ignores isTTY and NO_COLOR (see list.ts).
          style: { compact: true, 'padding-left': 1, 'padding-right': 1, head: [], border: [] },
          head: [
            chalk.gray('Score'),
            chalk.gray('Type'),
            chalk.gray('Name'),
            chalk.gray('Source'),
            chalk.gray('Description'),
          ],
        });

        for (const result of results) {
          const { entry, score } = result;
          const colorFn = typeColor(entry.type);

          table.push([
            formatScore(score),
            colorFn(`${typeEmoji(entry.type)}`),
            highlightMatch(colorFn(safeText(entry.name)), query),
            chalk.dim(safeText(entry.source)),
            truncate(highlightMatch(safeText(entry.description), query), 50),
          ]);
        }

        console.log(`\n${table.toString()}`);
        console.log(
          chalk.dim(
            `\n${results.length} result${results.length === 1 ? '' : 's'} for "${query}"\n`,
          ),
        );
      });
    });

  return cmd;
}
