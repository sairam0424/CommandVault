#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';
import {
  camelToKebab,
  globalOptionArgs,
  parseTierOption,
  resolveClaudePath,
  resolveProjectRoot,
} from './config.js';
import { installProcessHandlers, runCli } from './errors.js';

installProcessHandlers();

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

// Parse errors and --help/--version surface as CommanderError so `withCommand` maps them to exit codes.
program.exitOverride();

/** The global options, declared on the root program and again on the wrapper that runs a command. */
function addGlobalOptions(command: Command): Command {
  return command
    .option('--claude-path <path>', 'Override ~/.claude config location')
    .option('--tier <tier>', 'Search engine tier (fuse|minisearch|sqlite)')
    .option('--json', 'Output as JSON (for scripting)')
    .option(
      '--project [dir]',
      'Also scan a project directory for agent configs (bare: the current directory)',
    );
}

addGlobalOptions(
  program
    .name('vault')
    .version(version)
    .description('CommandVault — terminal companion for managing AI slash commands'),
);

// The default action takes no arguments, which would otherwise switch off the implicit `help` command.
program.helpCommand(true);

// Validate the global options once, before any command runs, and hand commands the resolved paths.
program.hook('preAction', (thisCommand) => {
  const { tier, claudePath, project } = thisCommand.opts<{
    tier?: string;
    claudePath?: string;
    project?: string | true;
  }>();
  if (tier !== undefined) {
    parseTierOption(tier);
  }
  if (claudePath !== undefined) {
    thisCommand.setOptionValue('claudePath', resolveClaudePath(claudePath));
  }
  if (project !== undefined) {
    thisCommand.setOptionValue('project', resolveProjectRoot(project));
  }
});

program.addHelpText(
  'after',
  `
Commands grouped:
  Discovery:    list, search, info, stats, interactive
  Management:   favorite, tag, open, run
  Data:         export, import, sync, backup, restore, diff
  Quality:      audit
  Registry:     registry add|remove|list|search
  Setup:        init, config, doctor, watch, completions
`,
);

/** Makes commander throw a CommanderError instead of exiting, for the command and its subcommands. */
function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) {
    applyExitOverride(sub);
  }
}

/**
 * Lazily load a command module and execute it within a parent context
 * that preserves global options (--json, --claude-path, --tier).
 *
 * This approach avoids eagerly importing heavy dependencies (core, ink, react)
 * at CLI startup, reducing cold-start time from ~400ms to ~80ms for simple
 * commands like `vault --version` or `vault --help`.
 */
async function lazyRun(
  importFn: () => Promise<Record<string, unknown>>,
  factoryName: string,
  argv: readonly string[],
): Promise<void> {
  const mod = await importFn();
  const factory = mod[factoryName] as () => Command;
  const cmd = factory();

  // Create a parent program that carries the global options, so that
  // command.optsWithGlobals() inside the action handler sees them.
  const wrapper = addGlobalOptions(new Command());
  wrapper.addCommand(cmd);
  applyExitOverride(wrapper);

  await wrapper.parseAsync(argv as string[]);
}

/**
 * Build the full argv array for forwarding to the lazily-loaded command.
 * Includes the command name (and subcommand, for `config`/`registry`) plus any positional args and
 * options from the outer shell command that already parsed them, then the global options.
 */
function buildLazyArgv(commandName: string, command: Command, subcommand?: string): string[] {
  const argv = ['node', 'vault', commandName, ...(subcommand ? [subcommand] : [])];

  // Forward positional arguments
  for (const arg of command.args ?? []) {
    argv.push(arg);
  }

  // Forward local options
  const opts = command.opts();
  for (const [key, value] of Object.entries(opts)) {
    if (value === true) {
      argv.push(`--${camelToKebab(key)}`);
    } else if (value === false) {
      // Boolean negation (--no-xxx)
      argv.push(`--no-${camelToKebab(key)}`);
    } else if (value !== undefined) {
      argv.push(`--${camelToKebab(key)}`, String(value));
    }
  }

  // The root program owns the global options wherever they appeared on the command line.
  argv.push(...globalOptionArgs(program.opts()));

  return argv;
}

/**
 * Commander invokes an action as `fn(...declaredArguments, options, command)`, so how many
 * parameters precede the Command depends on how many `.argument()`s the shell declares. The
 * Command is always the LAST argument; never index it by position.
 */
function commandFromActionArgs(actionArgs: readonly unknown[]): Command {
  return actionArgs[actionArgs.length - 1] as Command;
}

/**
 * Action handler for a shell command whose real implementation is loaded lazily. `subcommand`
 * names the leaf for `config`/`registry`, whose shells mirror the real subcommands so `--help`
 * lists them.
 */
function lazyAction(
  commandName: string,
  importFn: () => Promise<Record<string, unknown>>,
  factoryName: string,
  subcommand?: string,
): (...actionArgs: unknown[]) => Promise<void> {
  return async (...actionArgs) => {
    const command = commandFromActionArgs(actionArgs);
    await lazyRun(importFn, factoryName, buildLazyArgv(commandName, command, subcommand));
  };
}

/**
 * Runs the interactive command for both `vault interactive` and the bare `vault`. The root program
 * owns `--tui`/`--no-tui` (it swallows them wherever they appear), so the mode is read from the
 * merged options, and the global options are forwarded like for any other command.
 */
async function runInteractive(...actionArgs: unknown[]): Promise<void> {
  const { tui } = commandFromActionArgs(actionArgs).optsWithGlobals<{ tui?: boolean }>();
  const mode = tui === undefined ? [] : [tui ? '--tui' : '--no-tui'];
  await lazyRun(() => import('./commands/interactive.js'), 'createInteractiveCommand', [
    'node',
    'vault',
    'interactive',
    ...mode,
    ...globalOptionArgs(program.opts()),
  ]);
}

// --- list ---
program
  .command('list')
  .alias('ls')
  .description('List all entries in the vault')
  .option('-t, --type <type>', 'Filter by entry type (skill|agent|command|plugin|rule|hook)')
  .option('-s, --source <source>', 'Filter by source')
  .option('--tag <tag>', 'Filter by tag')
  .option('-f, --favorites', 'Show only favorites')
  .action(lazyAction('list', () => import('./commands/list.js'), 'createListCommand'));

// --- search ---
program
  .command('search')
  .alias('s')
  .description('Search entries with fuzzy matching')
  .argument('<query>', 'Search query')
  .option('-t, --type <type>', 'Filter by entry type')
  .option('-s, --source <source>', 'Filter by source')
  .option('--tag <tag>', 'Filter results by tag')
  .option('-l, --limit <n>', 'Maximum results', '20')
  .action(lazyAction('search', () => import('./commands/search.js'), 'createSearchCommand'));

// --- info ---
program
  .command('info')
  .alias('nfo')
  .description('Show detailed info about an entry')
  .argument('<name>', 'Entry name (fuzzy matched)')
  .action(lazyAction('info', () => import('./commands/info.js'), 'createInfoCommand'));

// --- stats ---
program
  .command('stats')
  .description('Show vault statistics dashboard')
  .action(lazyAction('stats', () => import('./commands/stats.js'), 'createStatsCommand'));

// --- export ---
program
  .command('export')
  .description('Export vault entries to JSON')
  .argument('[output-path]', 'Output file path', './commandvault-export.json')
  .option('-t, --type <type>', 'Filter by entry type')
  .option('-s, --source <source>', 'Filter by source')
  .option('-p, --pretty', 'Pretty-print JSON output')
  .action(lazyAction('export', () => import('./commands/export-cmd.js'), 'createExportCommand'));

// --- favorite ---
program
  .command('favorite')
  .alias('fav')
  .description('Toggle favorite status on an entry (or bulk with --type)')
  .argument('[name]', 'Entry name (fuzzy matched)')
  .option('--type <type>', 'Apply to all entries of this type (bulk operation)')
  .action(lazyAction('favorite', () => import('./commands/favorite.js'), 'createFavoriteCommand'));

// --- init ---
program
  .command('init')
  .description('Initialize CommandVault configuration')
  .option('--reset', 'Reset existing config to defaults')
  .action(lazyAction('init', () => import('./commands/init.js'), 'createInitCommand'));

// --- doctor ---
program
  .command('doctor')
  .description('Check system health and diagnose configuration issues')
  .action(lazyAction('doctor', () => import('./commands/doctor.js'), 'createDoctorCommand'));

// --- import ---
program
  .command('import')
  .description('Import commands from a .vault.json file or URL')
  .argument('<source>', 'Path to .vault.json file or URL')
  .option('--dry-run', 'Preview what would be imported without saving')
  .action(lazyAction('import', () => import('./commands/import-cmd.js'), 'createImportCommand'));

// --- sync ---
program
  .command('sync')
  .description('Sync commands from a remote registry URL')
  .argument('<url>', 'URL to a .vault.json registry')
  .option('--dry-run', 'Preview without saving')
  .action(lazyAction('sync', () => import('./commands/sync.js'), 'createSyncCommand'));

// --- tag ---
program
  .command('tag')
  .description('Manage user-defined tags on vault entries')
  .argument('<action>', 'Action to perform (add|remove|list)')
  .argument('[name]', 'Entry name (fuzzy matched)')
  .argument('[tag]', 'Tag to add or remove')
  .option('--type <type>', 'Apply to all entries of this type (bulk operation)')
  .action(lazyAction('tag', () => import('./commands/tag.js'), 'createTagCommand'));

// --- diff ---
program
  .command('diff')
  .description('Show what changed since the last scan snapshot')
  .action(lazyAction('diff', () => import('./commands/diff.js'), 'createDiffCommand'));

// --- watch ---
program
  .command('watch')
  .description('Live mode — print file changes as they happen')
  .action(lazyAction('watch', () => import('./commands/watch.js'), 'createWatchCommand'));

// --- interactive ---
program
  .command('interactive')
  .alias('i')
  .description('Interactive fuzzy search mode (full TUI in terminal, legacy mode in pipes)')
  .option('--tui', 'Force TUI mode')
  .option('--no-tui', 'Force legacy non-interactive mode')
  .action(runInteractive);

// --- open ---
program
  .command('open')
  .alias('o')
  .description('Open an entry source file in your editor')
  .argument('<name>', 'Entry name (fuzzy matched)')
  .action(lazyAction('open', () => import('./commands/open.js'), 'createOpenCommand'));

// --- run ---
program
  .command('run')
  .alias('r')
  .description('Get the slash command for an entry')
  .argument('<name>', 'Entry name (fuzzy matched)')
  .action(lazyAction('run', () => import('./commands/run.js'), 'createRunCommand'));

// --- backup ---
program
  .command('backup')
  .description('Backup the vault database')
  .option('--list', 'List available backups')
  .action(lazyAction('backup', () => import('./commands/backup.js'), 'createBackupCommand'));

// --- restore ---
program
  .command('restore')
  .description('Restore the vault database from a backup')
  .argument('<file>', 'Backup filename (from `vault backup --list`)')
  .action(lazyAction('restore', () => import('./commands/restore.js'), 'createRestoreCommand'));

// --- config ---
const configShell = program.command('config').description('Manage CommandVault configuration');
const lazyConfig = (subcommand: string) =>
  lazyAction('config', () => import('./commands/config.js'), 'createConfigCommand', subcommand);
configShell
  .command('get')
  .argument('[key]', 'Config key to read (omit for full config)')
  .description('Read a config value or the full config')
  .action(lazyConfig('get'));
configShell
  .command('set')
  .argument('<key>', 'Config key (claudeConfigPath|searchTier|enableWatcher|projectPaths)')
  .argument('<value>', 'Config value')
  .description('Set a config value')
  .action(lazyConfig('set'));

// --- completions ---
program
  .command('completions')
  .description('Generate shell completion scripts')
  .argument('<shell>', 'Shell type (bash|zsh|fish)')
  .action(
    lazyAction(
      'completions',
      () => import('./commands/completions.js'),
      'createCompletionsCommand',
    ),
  );

// --- registry ---
const registryShell = program.command('registry').description('Manage remote skill registries');
const lazyRegistry = (subcommand: string) =>
  lazyAction(
    'registry',
    () => import('./commands/registry.js'),
    'createRegistryCommand',
    subcommand,
  );
registryShell
  .command('add <name> <url>')
  .option('--type <type>', 'Registry type (json|api)', 'json')
  .description('Add a remote registry')
  .action(lazyRegistry('add'));
registryShell
  .command('remove <name>')
  .description('Remove a registry')
  .action(lazyRegistry('remove'));
registryShell
  .command('list')
  .description('List configured registries')
  .action(lazyRegistry('list'));
registryShell
  .command('search <query>')
  .description('Search across all registries')
  .option('--limit <n>', 'Max results', '10')
  .action(lazyRegistry('search'));

// --- audit ---
program
  .command('audit')
  .description('Detect stale entries and score vault quality')
  .option('--threshold <days>', 'Staleness threshold in days', '30')
  .option('--min-score <score>', 'Minimum quality score threshold', '40')
  .option('--fail-under', 'Exit 1 when any entry scores below --min-score')
  .action(lazyAction('audit', () => import('./commands/audit.js'), 'createAuditCommand'));

// Default action: launch interactive mode when no subcommand is given
program.option('--tui', 'Force TUI mode').option('--no-tui', 'Force legacy non-interactive mode');

program.action(runInteractive);

runCli(() => program.parseAsync(process.argv));
