import { Command } from 'commander';
import chalk from 'chalk';
import { RegistryManager } from '@commandvault/core';
import { CommandError, EXIT_RUNTIME_ERROR, invalidChoiceError, usageError } from '../errors.js';
import type { RegistryConfig } from '@commandvault/core';
import { readConfigDocument, writeConfigDocument } from '../config.js';
import { toDisplay } from '../ui/safe-text.js';

/** Every registry type the vault can read, in the order error messages list them. */
const REGISTRY_TYPES = ['json', 'api'] as const satisfies readonly RegistryConfig['type'][];

/** Fails to compile when core adds a registry type that is missing from {@link REGISTRY_TYPES}. */
export type AssertAllRegistryTypesListed<
  Missing extends never = Exclude<RegistryConfig['type'], (typeof REGISTRY_TYPES)[number]>,
> = Missing;

function isRegistryType(value: string): value is RegistryConfig['type'] {
  return (REGISTRY_TYPES as readonly string[]).includes(value);
}

async function loadRegistries(): Promise<readonly RegistryConfig[]> {
  const { registries } = await readConfigDocument();
  return Array.isArray(registries) ? (registries as RegistryConfig[]) : [];
}

/** Rewrites only the `registries` key; refuses (and leaves the file alone) if config.json is unreadable. */
async function saveRegistries(registries: readonly RegistryConfig[]): Promise<void> {
  const existing = await readConfigDocument();
  await writeConfigDocument({ ...existing, registries });
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
      if (!isRegistryType(opts.type)) {
        throw invalidChoiceError('--type', opts.type, REGISTRY_TYPES);
      }
      const type = opts.type;
      try {
        new URL(url);
      } catch {
        throw usageError(`invalid URL "${url}"`);
      }
      const registries = [...(await loadRegistries())];
      if (registries.some((r) => r.name === name)) {
        throw new CommandError(
          `registry "${name}" already exists`,
          EXIT_RUNTIME_ERROR,
          `remove it first with \`vault registry remove ${name}\``,
        );
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
        throw new CommandError(`registry "${name}" not found`);
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
      // Remote records: every field is an open string, so the whole record is shown as a view.
      for (const view of result.entries.map(toDisplay)) {
        const tags = view.tags?.length ? chalk.dim(` [${view.tags.join(', ')}]`) : '';
        console.log(`  ${chalk.cyan(view.name)} ${chalk.dim(`(${view.type})`)}${tags}`);
        console.log(`    ${view.description}`);
        console.log(`    ${chalk.dim(`from: ${view.source}`)}`);
        console.log('');
      }
    });

  return cmd;
}
