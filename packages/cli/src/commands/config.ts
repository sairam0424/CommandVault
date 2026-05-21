import { Command } from 'commander';
import chalk from 'chalk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_PATH = join(homedir(), '.commandvault', 'config.json');

async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Parse JSON arrays and objects
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through to treat as plain string
    }
  }

  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && raw.trim() !== '') return asNum;

  // Expand tilde to home directory
  if (raw.startsWith('~')) {
    return raw.replace(/^~/, homedir());
  }

  return raw;
}

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const parts = key.split('.');
  if (parts.length === 1) {
    return { ...obj, [key]: value };
  }

  const [head, ...rest] = parts;
  const child =
    typeof obj[head] === 'object' && obj[head] !== null
      ? { ...(obj[head] as Record<string, unknown>) }
      : {};
  return {
    ...obj,
    [head]: setNestedValue(child, rest.join('.'), value),
  };
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('Manage CommandVault configuration');

  cmd
    .command('get')
    .argument('[key]', 'Config key to read (omit for full config)')
    .description('Read a config value or the full config')
    .action(async (key?: string) => {
      const config = await readConfig();

      if (!key) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }

      const value = getNestedValue(config, key);
      if (value === undefined) {
        console.log(chalk.yellow(`Key "${key}" is not set.`));
        return;
      }

      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    });

  cmd
    .command('set')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .description('Set a config value')
    .action(async (key: string, rawValue: string) => {
      const config = await readConfig();
      const value = parseValue(rawValue);
      const updated = setNestedValue(config, key, value);
      await writeConfig(updated);
      console.log(chalk.green(`Set ${chalk.bold(key)} = ${JSON.stringify(value)}`));
    });

  return cmd;
}

export { readConfig, writeConfig, parseValue, CONFIG_PATH };
