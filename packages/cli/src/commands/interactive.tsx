import { Command } from 'commander';
import chalk from 'chalk';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { search, select } from '@inquirer/prompts';
import type { VaultEntry } from '@commandvault/core';
import {
  createConfiguredVault,
  typeEmoji,
  typeColor,
  truncate,
  formatDate,
  type CliGlobalOptions,
} from '../helpers.js';
import { createSpinner } from '../ui/spinner.js';
import { openInEditor } from '../editor.js';
import { CommandError } from '../errors.js';

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
  console.log(`${chalk.dim('Usage:')}       ${entry.usageCount} time${entry.usageCount === 1 ? '' : 's'}`);
  console.log(`${chalk.dim('Favorite:')}    ${entry.favorite ? chalk.yellow('* Yes') : chalk.dim('  No')}`);
  console.log(chalk.dim('─'.repeat(50)));
}

async function runLegacyMode(globalOpts: CliGlobalOptions): Promise<void> {
  const vault = await createConfiguredVault(globalOpts, false);
  const spinner = createSpinner('Initializing vault...').start();
  try {
    const stats = await vault.initialize();
    spinner.succeed(`Vault loaded: ${stats.totalEntries} entries indexed`);
  } catch (err) {
    spinner.fail('Failed to initialize vault');
    throw err;
  }

  try {
    let keepSearching = true;
    while (keepSearching) {
      const selectedEntry = await search<VaultEntry>({
        message: 'Search commands:',
        source: (term) => {
          if (!term) return [];
          return vault.quickSearch(term, 15).map((r) => ({
            value: r.entry,
            name: formatEntryChoice(r.entry),
          }));
        },
        pageSize: 15,
      });

      const slashCommand = vault.getSlashCommand(selectedEntry);
      displayEntryDetail(selectedEntry, slashCommand);
      vault.recordUsage(selectedEntry.id);

      let actionLoop = true;
      while (actionLoop) {
        const action = await select<ActionChoice>({
          message: 'What next?',
          choices: [
            { value: 'copy', name: 'Copy slash command (print to stdout)' },
            { value: 'open', name: 'Open file in editor' },
            { value: 'again', name: 'Search again' },
            { value: 'exit', name: 'Exit' },
          ],
        });

        switch (action) {
          case 'copy': {
            console.log('');
            console.log(chalk.green.bold(`  ${slashCommand}`));
            console.log('');
            break;
          }
          case 'open': {
            const resolvedPath = resolve(selectedEntry.filePath);
            try {
              accessSync(resolvedPath, constants.R_OK);
            } catch {
              console.error(chalk.red(`\nFile not found: ${selectedEntry.filePath}`));
              break;
            }
            try {
              openInEditor(resolvedPath);
            } catch (err) {
              if (!(err instanceof CommandError)) throw err;
              console.error(chalk.red(err.message));
            }
            break;
          }
          case 'again': { actionLoop = false; break; }
          case 'exit': { actionLoop = false; keepSearching = false; break; }
        }
      }
    }
  } finally {
    await vault.dispose();
  }
}

async function runTuiMode(globalOpts: CliGlobalOptions): Promise<void> {
  const { render } = await import('ink');
  const { App } = await import('../tui/App.js');
  const vault = await createConfiguredVault(globalOpts, true);
  const spinner = createSpinner('Initializing vault...').start();

  try {
    const stats = await vault.initialize();
    spinner.succeed(`Vault loaded: ${stats.totalEntries} entries`);
  } catch (err) {
    spinner.fail('Failed to initialize vault');
    await vault.dispose();
    throw err;
  }

  const { waitUntilExit } = render(<App vault={vault} />);

  try {
    await waitUntilExit();
  } finally {
    await vault.dispose();
  }
}

export function createInteractiveCommand(): Command {
  return new Command('interactive')
    .alias('i')
    .description('Interactive fuzzy search mode (full TUI in terminal, legacy mode in pipes)')
    .option('--tui', 'Force TUI mode')
    .option('--no-tui', 'Force legacy non-interactive mode')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;
      const localOpts = command.opts();

      let useTui: boolean;
      if (localOpts.tui === true) {
        useTui = true;
      } else if (localOpts.tui === false) {
        useTui = false;
      } else {
        useTui = Boolean(process.stdout.isTTY && process.stdin.isTTY);
      }

      if (useTui) {
        await runTuiMode(globalOpts);
      } else {
        await runLegacyMode(globalOpts);
      }
    });
}
