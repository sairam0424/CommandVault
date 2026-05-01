import { Command } from 'commander';
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';

const COMMANDVAULT_DIR = join(homedir(), '.commandvault');
const CONFIG_PATH = join(COMMANDVAULT_DIR, 'config.json');

interface CommandVaultConfig {
  readonly claudeConfigPath: string;
  readonly searchTier: string;
  readonly enableWatcher: boolean;
  readonly projectPaths: readonly string[];
}

const DEFAULT_CONFIG: CommandVaultConfig = {
  claudeConfigPath: '~/.claude',
  searchTier: 'minisearch',
  enableWatcher: true,
  projectPaths: [],
};

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

      const configExists = await fileExists(CONFIG_PATH);

      if (configExists && !isReset) {
        const raw = await readFile(CONFIG_PATH, 'utf-8');
        let existingConfig: CommandVaultConfig;

        try {
          existingConfig = JSON.parse(raw) as CommandVaultConfig;
        } catch {
          console.log(chalk.red('  Existing config is invalid JSON.'));
          console.log(chalk.yellow(`  Run ${chalk.bold('vault init --reset')} to recreate it.`));
          console.log('');
          return;
        }

        console.log(chalk.cyan('  Config already exists at:'));
        console.log(chalk.dim(`  ${CONFIG_PATH}`));
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
      await mkdir(COMMANDVAULT_DIR, { recursive: true });

      // Write config
      await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');

      if (isReset && configExists) {
        console.log(chalk.green('  Config reset to defaults.'));
      } else {
        console.log(chalk.green('  Created ~/.commandvault/ directory'));
        console.log(chalk.green(`  Created config at ${CONFIG_PATH}`));
      }

      console.log('');
      console.log(chalk.white('  Default configuration:'));
      console.log('');

      const entries = Object.entries(DEFAULT_CONFIG);
      for (const [key, value] of entries) {
        const formatted = Array.isArray(value)
          ? value.length > 0
            ? value.join(', ')
            : chalk.dim('(empty)')
          : String(value);
        console.log(`  ${chalk.dim(key + ':')}  ${formatted}`);
      }

      console.log('');
      console.log(chalk.bold.white('  Next steps:'));
      console.log(chalk.dim('  ' + '-'.repeat(40)));
      console.log(`  1. Run ${chalk.cyan('vault list')} to see all indexed entries`);
      console.log(`  2. Run ${chalk.cyan('vault search <query>')} to search commands`);
      console.log(`  3. Run ${chalk.cyan('vault doctor')} to verify your setup`);
      console.log('');
    });

  return cmd;
}
