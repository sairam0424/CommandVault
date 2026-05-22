import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { RegistryManager } from '@commandvault/core';
import type { RegistryConfig } from '@commandvault/core';

const CONFIG_DIR = join(homedir(), '.commandvault');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

async function loadRegistries(): Promise<readonly RegistryConfig[]> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const registries = parsed.registries;
    if (!Array.isArray(registries)) return [];
    return registries as RegistryConfig[];
  } catch {
    return [];
  }
}

async function saveRegistries(registries: readonly RegistryConfig[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // file doesn't exist yet
  }
  const updated = { ...existing, registries };
  await writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
}

function buildManager(configs: readonly RegistryConfig[]): RegistryManager {
  const manager = new RegistryManager();
  for (const config of configs) {
    manager.addRegistry(config);
  }
  return manager;
}

export function createRegistryCommand(): Command {
  const cmd = new Command('registry').description('Manage remote skill registries');

  cmd
    .command('add <name> <url>')
    .option('--type <type>', 'Registry type (json|api)', 'json')
    .description('Add a remote registry')
    .action(async (name: string, url: string, opts: { type: string }) => {
      try {
        new URL(url);
      } catch {
        console.error(chalk.red(`Invalid URL: ${url}`));
        process.exit(1);
      }
      const type = opts.type === 'api' ? 'api' : 'json';
      const registries = [...(await loadRegistries())];
      if (registries.some((r) => r.name === name)) {
        console.error(chalk.red(`Registry "${name}" already exists. Remove it first.`));
        process.exit(1);
      }
      const config: RegistryConfig = { name, url, type };
      registries.push(config);
      await saveRegistries(registries);
      console.log(chalk.green(`Added registry "${name}" (${type}) → ${url}`));
    });

  cmd
    .command('remove <name>')
    .description('Remove a registry')
    .action(async (name: string) => {
      const registries = await loadRegistries();
      const filtered = registries.filter((r) => r.name !== name);
      if (filtered.length === registries.length) {
        console.error(chalk.red(`Registry "${name}" not found.`));
        process.exit(1);
      }
      await saveRegistries(filtered);
      console.log(chalk.green(`Removed registry "${name}"`));
    });

  cmd
    .command('list')
    .description('List configured registries')
    .action(async () => {
      const registries = await loadRegistries();
      if (registries.length === 0) {
        console.log(
          chalk.dim('No registries configured. Use `vault registry add <name> <url>` to add one.'),
        );
        return;
      }
      console.log(chalk.bold('Configured registries:\n'));
      for (const r of registries) {
        console.log(`  ${chalk.cyan(r.name)} (${r.type}) → ${chalk.dim(r.url)}`);
      }
    });

  cmd
    .command('search <query>')
    .description('Search across all registries')
    .option('--limit <n>', 'Max results', '10')
    .action(async (query: string, opts: { limit: string }) => {
      const registries = await loadRegistries();
      if (registries.length === 0) {
        console.log(
          chalk.dim('No registries configured. Use `vault registry add <name> <url>` to add one.'),
        );
        return;
      }
      const manager = buildManager(registries);
      const limit = parseInt(opts.limit, 10) || 10;
      const result = await manager.search(query, { limit });

      if (result.entries.length === 0) {
        console.log(chalk.dim(`No results for "${query}"`));
        return;
      }
      console.log(chalk.bold(`Found ${result.total} result(s) for "${query}":\n`));
      for (const entry of result.entries) {
        const tags = entry.tags?.length ? chalk.dim(` [${entry.tags.join(', ')}]`) : '';
        console.log(`  ${chalk.cyan(entry.name)} ${chalk.dim(`(${entry.type})`)}${tags}`);
        console.log(`    ${entry.description}`);
        console.log(`    ${chalk.dim(`from: ${entry.source}`)}`);
        console.log('');
      }
    });

  return cmd;
}
