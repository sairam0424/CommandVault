import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { search, select } from '@inquirer/prompts';
import type { VaultEntry } from '@commandvault/core';
import {
  createVaultInstance,
  typeEmoji,
  typeColor,
  truncate,
  formatDate,
  type CliGlobalOptions,
} from '../helpers.js';

type ActionChoice = 'copy' | 'open' | 'again' | 'exit';

function formatEntryChoice(entry: VaultEntry): string {
  return `${typeEmoji(entry.type)} ${entry.name} — ${truncate(entry.description || '(no description)', 50)}`;
}

function displayEntryDetail(entry: VaultEntry, slashCommand: string): void {
  const colorFn = typeColor(entry.type);

  console.log('');
  console.log(chalk.bold(`${typeEmoji(entry.type)} ${colorFn(entry.name)}`));
  console.log(chalk.dim('─'.repeat(50)));
  console.log(`${chalk.dim('Type:')}        ${colorFn(entry.type)}`);
  console.log(`${chalk.dim('Source:')}      ${entry.source}`);
  console.log(`${chalk.dim('Command:')}     ${chalk.bold(slashCommand)}`);
  console.log(`${chalk.dim('Description:')} ${entry.description || chalk.dim('(no description)')}`);
  console.log(
    `${chalk.dim('Tags:')}        ${entry.tags.length > 0 ? entry.tags.map((t) => chalk.cyan(`#${t}`)).join(' ') : chalk.dim('(none)')}`,
  );
  console.log(`${chalk.dim('File:')}        ${chalk.underline(entry.filePath)}`);
  console.log(`${chalk.dim('Modified:')}    ${formatDate(entry.lastModified)}`);
  console.log(
    `${chalk.dim('Usage:')}       ${entry.usageCount} time${entry.usageCount === 1 ? '' : 's'}`,
  );
  console.log(
    `${chalk.dim('Favorite:')}    ${entry.favorite ? chalk.yellow('* Yes') : chalk.dim('  No')}`,
  );
  console.log(chalk.dim('─'.repeat(50)));
}

async function promptAction(): Promise<ActionChoice> {
  const action = await select<ActionChoice>({
    message: 'What next?',
    choices: [
      { value: 'copy', name: 'Copy slash command (print to stdout)' },
      { value: 'open', name: 'Open file in editor' },
      { value: 'again', name: 'Search again' },
      { value: 'exit', name: 'Exit' },
    ],
  });

  return action;
}

export function createInteractiveCommand(): Command {
  const cmd = new Command('interactive')
    .alias('i')
    .description('Interactive fuzzy search mode')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      const vault = await createVaultInstance(globalOpts);

      try {
        let keepSearching = true;

        while (keepSearching) {
          const selectedEntry = await search<VaultEntry>({
            message: 'Search commands:',
            source: (term) => {
              if (!term) {
                return [];
              }

              const results = vault.quickSearch(term, 15);

              return results.map((result) => ({
                value: result.entry,
                name: formatEntryChoice(result.entry),
              }));
            },
            pageSize: 15,
          });

          const slashCommand = vault.getSlashCommand(selectedEntry);
          displayEntryDetail(selectedEntry, slashCommand);
          vault.recordUsage(selectedEntry.id);

          let actionLoop = true;

          while (actionLoop) {
            const action = await promptAction();

            switch (action) {
              case 'copy': {
                console.log('');
                console.log(chalk.green.bold(`  ${slashCommand}`));
                console.log('');
                break;
              }
              case 'open': {
                const editor = process.env.EDITOR || 'code';
                try {
                  execFileSync(editor, [selectedEntry.filePath], { stdio: 'inherit' });
                } catch {
                  console.log(
                    chalk.red(`Failed to open editor (${editor}). Set $EDITOR to override.`),
                  );
                }
                break;
              }
              case 'again': {
                actionLoop = false;
                break;
              }
              case 'exit': {
                actionLoop = false;
                keepSearching = false;
                break;
              }
            }
          }
        }
      } finally {
        await vault.dispose();
      }
    });

  return cmd;
}
