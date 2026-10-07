import { Command } from 'commander';
import chalk from 'chalk';
import {
  parseConfigValue,
  readConfigDocument,
  writeConfigDocument,
  type ConfigDocument,
} from '../config.js';
import { jsonOutput } from '../helpers.js';
import { safeText } from '../ui/safe-text.js';

function getNestedValue(obj: ConfigDocument, key: string): unknown {
  let current: unknown = obj;
  for (const part of key.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('Manage CommandVault configuration');

  cmd
    .command('get')
    .argument('[key]', 'Config key to read (omit for full config)')
    .description('Read a config value or the full config')
    .action(async (key?: string) => {
      const config = await readConfigDocument();

      if (!key) {
        jsonOutput(config);
        return;
      }

      const value = getNestedValue(config, key);
      if (value === undefined) {
        console.log(chalk.yellow(`Key "${key}" is not set.`));
        return;
      }

      if (typeof value === 'object' && value !== null) {
        jsonOutput(value);
      } else {
        console.log(String(value));
      }
    });

  cmd
    .command('set')
    .argument('<key>', 'Config key (claudeConfigPath|searchTier|enableWatcher|projectPaths)')
    .argument('<value>', 'Config value')
    .description('Set a config value')
    .action(async (key: string, rawValue: string) => {
      const value = parseConfigValue(key, rawValue);
      const config = await readConfigDocument();
      await writeConfigDocument({ ...config, [key]: value });
      console.log(chalk.green(`Set ${chalk.bold(key)} = ${safeText(JSON.stringify(value))}`));
    });

  return cmd;
}
