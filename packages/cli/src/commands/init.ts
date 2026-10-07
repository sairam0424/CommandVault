import { Command } from 'commander';
import chalk from 'chalk';
import { dirname } from 'node:path';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolveClaudeDir } from '@commandvault/core';
import { configFilePath, dbFilePath } from '../config.js';
import { CommandError, EXIT_RUNTIME_ERROR } from '../errors.js';

interface CommandVaultConfig {
  readonly claudeConfigPath?: string;
  readonly searchTier: string;
  readonly enableWatcher: boolean;
  readonly projectPaths: readonly string[];
}

const DEFAULT_CLAUDE_CONFIG_PATH = '~/.claude';

/**
 * A `claudeConfigPath` in config.json outranks CLAUDE_CONFIG_DIR. Writing the `~/.claude` default
 * over a redirected Claude directory would ignore the variable, and recording the variable's
 * current value would freeze it: a later profile switch would never apply. So the key is written
 * only while the directory in use is the default one, and left out while the variable redirects it.
 */
function buildDefaultConfig(): CommandVaultConfig {
  const isClaudeDirRedirected = resolveClaudeDir() !== resolveClaudeDir({});
  return {
    ...(isClaudeDirRedirected ? {} : { claudeConfigPath: DEFAULT_CLAUDE_CONFIG_PATH }),
    searchTier: 'minisearch',
    enableWatcher: true,
    projectPaths: [],
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createInitCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize CommandVault configuration')
    .option('--reset', 'Reset existing config to defaults')
    .action(async (opts) => {
      const isReset = opts.reset === true;

      console.log('');
      console.log(chalk.bold.white('  CommandVault Init'));
      console.log(chalk.dim('  ' + '='.repeat(40)));
      console.log('');

      const configPath = configFilePath();
      const configExists = await fileExists(configPath);

      if (configExists && !isReset) {
        const raw = await readFile(configPath, 'utf-8');
        let existingConfig: CommandVaultConfig;

        try {
          existingConfig = JSON.parse(raw) as CommandVaultConfig;
        } catch {
          throw new CommandError(
            'existing config is invalid JSON',
            EXIT_RUNTIME_ERROR,
            'run `vault init --reset` to recreate it',
          );
        }

        console.log(chalk.cyan('  Config already exists at:'));
        console.log(chalk.dim(`  ${configPath}`));
        console.log('');
        console.log(chalk.white('  Current configuration:'));
        console.log('');

        const entries = Object.entries(existingConfig);
        for (const [key, value] of entries) {
          const formatted = Array.isArray(value)
            ? value.length > 0
              ? value.join(', ')
              : chalk.dim('(empty)')
            : String(value);
          console.log(`  ${chalk.dim(key + ':')}  ${formatted}`);
        }

        console.log('');
        console.log(
          chalk.yellow(`  To reset to defaults, run: ${chalk.bold('vault init --reset')}`),
        );
        console.log('');
        return;
      }

      // Create directory
      await mkdir(dirname(configPath), { recursive: true });

      // safe-text: config.json is written to disk, not to the terminal
      await writeFile(configPath, JSON.stringify(buildDefaultConfig(), null, 2) + '\n', 'utf-8');

      if (isReset && configExists) {
        console.log(chalk.green('  Config reset to defaults.'));
      } else {
        console.log(chalk.green('  ✓ CommandVault initialized successfully!'));
      }

      console.log('');
      console.log(`  ${chalk.dim('Scanned:')}   ${resolveClaudeDir()}`);
      console.log(`  ${chalk.dim('Database:')}  ${dbFilePath()}`);
      console.log('');
      console.log(chalk.bold.white('  Next steps:'));
      console.log(chalk.dim('  ' + '-'.repeat(40)));
      console.log(`    ${chalk.cyan('vault list')}              List all indexed entries`);
      console.log(`    ${chalk.cyan('vault search <query>')}    Search your vault`);
      console.log(`    ${chalk.cyan('vault stats')}             View entry statistics`);
      console.log(`    ${chalk.cyan('vault doctor')}            Run health check`);
      console.log('');
    });

  return cmd;
}
