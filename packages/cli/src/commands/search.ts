import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { SearchResult, EntryType, EntrySource } from '@commandvault/core';
import {
  createVaultInstance,
  typeEmoji,
  typeColor,
  truncate,
  type CliGlobalOptions,
} from '../helpers.js';

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
    .option('-l, --limit <n>', 'Maximum results', '20')
    .action(async (query: string, _opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const opts = command.opts();

      const vault = await createVaultInstance(globalOpts);

      try {
        const results: readonly SearchResult[] = vault.search({
          query,
          type: opts.type as EntryType | undefined,
          source: opts.source as EntrySource | undefined,
          limit: parseInt(opts.limit, 10),
          tier: globalOpts.tier,
        });

        if (globalOpts.json) {
          console.log(JSON.stringify({ query, results }, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log(chalk.yellow(`\nNo results found for "${query}".\n`));
          return;
        }

        const table = new Table({
          style: { compact: true, 'padding-left': 1, 'padding-right': 1 },
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
            highlightMatch(colorFn(entry.name), query),
            chalk.dim(entry.source),
            truncate(highlightMatch(entry.description || '', query), 50),
          ]);
        }

        console.log(`\n${table.toString()}`);
        console.log(
          chalk.dim(
            `\n${results.length} result${results.length === 1 ? '' : 's'} for "${query}"\n`,
          ),
        );
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
