#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('vault')
  .version(version)
  .description('CommandVault — terminal companion for managing AI slash commands')
  .option('--claude-path <path>', 'Override ~/.claude config location')
  .option('--tier <tier>', 'Search engine tier (fuse|minisearch|sqlite)')
  .option('--json', 'Output as JSON (for scripting)');

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
  const wrapper = new Command();
  wrapper
    .option('--claude-path <path>', 'Override ~/.claude config location')
    .option('--tier <tier>', 'Search engine tier (fuse|minisearch|sqlite)')
    .option('--json', 'Output as JSON (for scripting)');
  wrapper.addCommand(cmd);

  await wrapper.parseAsync(argv as string[]);
}

/**
 * Build the full argv array for forwarding to the lazily-loaded command.
 * Includes the command name plus any positional args and options from the
 * outer shell command that already parsed them.
 */
function buildLazyArgv(commandName: string, command: Command): string[] {
  const argv = ['node', 'vault', commandName];

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

  // Forward global options from parent program
  const globalOpts = command.parent?.opts() ?? {};
  for (const [key, value] of Object.entries(globalOpts)) {
    if (value === true) {
      argv.push(`--${camelToKebab(key)}`);
    } else if (value !== undefined && value !== false) {
      argv.push(`--${camelToKebab(key)}`, String(value));
    }
  }

  return argv;
}

function camelToKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
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
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/list.js'),
      'createListCommand',
      buildLazyArgv('list', command),
    );
  });

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
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/search.js'),
      'createSearchCommand',
      buildLazyArgv('search', command),
    );
  });

// --- info ---
program
  .command('info')
  .alias('nfo')
  .description('Show detailed info about an entry')
  .argument('<name>', 'Entry name (fuzzy matched)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/info.js'),
      'createInfoCommand',
      buildLazyArgv('info', command),
    );
  });

// --- stats ---
program
  .command('stats')
  .description('Show vault statistics dashboard')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/stats.js'),
      'createStatsCommand',
      buildLazyArgv('stats', command),
    );
  });

// --- export ---
program
  .command('export')
  .description('Export vault entries to JSON')
  .argument('[output-path]', 'Output file path', './commandvault-export.json')
  .option('-t, --type <type>', 'Filter by entry type')
  .option('-s, --source <source>', 'Filter by source')
  .option('-p, --pretty', 'Pretty-print JSON output')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/export-cmd.js'),
      'createExportCommand',
      buildLazyArgv('export', command),
    );
  });

// --- favorite ---
program
  .command('favorite')
  .alias('fav')
  .description('Toggle favorite status on an entry (or bulk with --type)')
  .argument('[name]', 'Entry name (fuzzy matched)')
  .option('--type <type>', 'Apply to all entries of this type (bulk operation)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/favorite.js'),
      'createFavoriteCommand',
      buildLazyArgv('favorite', command),
    );
  });

// --- init ---
program
  .command('init')
  .description('Initialize CommandVault configuration')
  .option('--reset', 'Reset existing config to defaults')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/init.js'),
      'createInitCommand',
      buildLazyArgv('init', command),
    );
  });

// --- doctor ---
program
  .command('doctor')
  .description('Check system health and diagnose configuration issues')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/doctor.js'),
      'createDoctorCommand',
      buildLazyArgv('doctor', command),
    );
  });

// --- import ---
program
  .command('import')
  .description('Import commands from a .vault.json file or URL')
  .argument('<source>', 'Path to .vault.json file or URL')
  .option('--dry-run', 'Preview what would be imported without saving')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/import-cmd.js'),
      'createImportCommand',
      buildLazyArgv('import', command),
    );
  });

// --- sync ---
program
  .command('sync')
  .description('Sync commands from a remote registry URL')
  .argument('<url>', 'URL to a .vault.json registry')
  .option('--dry-run', 'Preview without saving')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/sync.js'),
      'createSyncCommand',
      buildLazyArgv('sync', command),
    );
  });

// --- tag ---
program
  .command('tag')
  .description('Manage user-defined tags on vault entries')
  .argument('<action>', 'Action to perform (add|remove|list)')
  .argument('[name]', 'Entry name (fuzzy matched)')
  .argument('[tag]', 'Tag to add or remove')
  .option('--type <type>', 'Apply to all entries of this type (bulk operation)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/tag.js'),
      'createTagCommand',
      buildLazyArgv('tag', command),
    );
  });

// --- diff ---
program
  .command('diff')
  .description('Show what changed since the last scan snapshot')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/diff.js'),
      'createDiffCommand',
      buildLazyArgv('diff', command),
    );
  });

// --- watch ---
program
  .command('watch')
  .description('Live mode — print file changes as they happen')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/watch.js'),
      'createWatchCommand',
      buildLazyArgv('watch', command),
    );
  });

// --- interactive ---
program
  .command('interactive')
  .alias('i')
  .description('Interactive fuzzy search mode (full TUI in terminal, legacy mode in pipes)')
  .option('--tui', 'Force TUI mode')
  .option('--no-tui', 'Force legacy non-interactive mode')
  .action(async (_opts, command) => {
    const { createInteractiveCommand } = await import('./commands/interactive.js');
    const realCmd = createInteractiveCommand();
    const args: string[] = [];
    const localOpts = command.opts();
    if (localOpts.tui === true) {
      args.push('--tui');
    } else if (localOpts.tui === false) {
      args.push('--no-tui');
    }
    await realCmd.parseAsync(args, { from: 'user' });
  });

// --- open ---
program
  .command('open')
  .alias('o')
  .description('Open an entry source file in your editor')
  .argument('<name>', 'Entry name (fuzzy matched)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/open.js'),
      'createOpenCommand',
      buildLazyArgv('open', command),
    );
  });

// --- run ---
program
  .command('run')
  .alias('r')
  .description('Get the slash command for an entry')
  .argument('<name>', 'Entry name (fuzzy matched)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/run.js'),
      'createRunCommand',
      buildLazyArgv('run', command),
    );
  });

// --- backup ---
program
  .command('backup')
  .description('Backup the vault database')
  .option('--list', 'List available backups')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/backup.js'),
      'createBackupCommand',
      buildLazyArgv('backup', command),
    );
  });

// --- restore ---
program
  .command('restore')
  .description('Restore the vault database from a backup')
  .argument('<file>', 'Backup filename (from `vault backup --list`)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/restore.js'),
      'createRestoreCommand',
      buildLazyArgv('restore', command),
    );
  });

// --- config ---
program
  .command('config')
  .description('Manage CommandVault configuration')
  .argument('[args...]', 'Subcommand and arguments (get [key] | set <key> <value>)')
  .action(async (_opts, command) => {
    const { createConfigCommand } = await import('./commands/config.js');
    const cmd = createConfigCommand();

    // Config uses subcommands — forward raw args
    const globalOpts = command.parent?.opts() ?? {};
    const wrapper = new Command();
    wrapper
      .option('--claude-path <path>', 'Override ~/.claude config location')
      .option('--tier <tier>', 'Search engine tier (fuse|minisearch|sqlite)')
      .option('--json', 'Output as JSON (for scripting)');
    wrapper.addCommand(cmd);

    const argv = ['node', 'vault', 'config', ...(command.args ?? [])];
    for (const [key, value] of Object.entries(globalOpts)) {
      if (value === true) {
        argv.push(`--${camelToKebab(key)}`);
      } else if (value !== undefined && value !== false) {
        argv.push(`--${camelToKebab(key)}`, String(value));
      }
    }
    await wrapper.parseAsync(argv);
  });

// --- completions ---
program
  .command('completions')
  .description('Generate shell completion scripts')
  .argument('<shell>', 'Shell type (bash|zsh|fish)')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/completions.js'),
      'createCompletionsCommand',
      buildLazyArgv('completions', command),
    );
  });

// --- registry ---
program
  .command('registry')
  .description('Manage remote skill registries')
  .argument('[args...]', 'Subcommand and arguments')
  .action(async (_opts, command) => {
    const { createRegistryCommand } = await import('./commands/registry.js');
    const cmd = createRegistryCommand();

    // Registry uses subcommands — forward raw args
    const globalOpts = command.parent?.opts() ?? {};
    const wrapper = new Command();
    wrapper
      .option('--claude-path <path>', 'Override ~/.claude config location')
      .option('--tier <tier>', 'Search engine tier (fuse|minisearch|sqlite)')
      .option('--json', 'Output as JSON (for scripting)');
    wrapper.addCommand(cmd);

    const argv = ['node', 'vault', 'registry', ...(command.args ?? [])];
    for (const [key, value] of Object.entries(globalOpts)) {
      if (value === true) {
        argv.push(`--${camelToKebab(key)}`);
      } else if (value !== undefined && value !== false) {
        argv.push(`--${camelToKebab(key)}`, String(value));
      }
    }
    await wrapper.parseAsync(argv);
  });

// --- audit ---
program
  .command('audit')
  .description('Detect stale entries and score vault quality')
  .option('--threshold <days>', 'Staleness threshold in days', '30')
  .option('--min-score <score>', 'Minimum quality score threshold', '40')
  .action(async (_opts, command) => {
    await lazyRun(
      () => import('./commands/audit.js'),
      'createAuditCommand',
      buildLazyArgv('audit', command),
    );
  });

// Default action: launch interactive mode when no subcommand is given
program.option('--tui', 'Force TUI mode').option('--no-tui', 'Force legacy non-interactive mode');

program.action(async (_opts, command) => {
  const { createInteractiveCommand } = await import('./commands/interactive.js');
  const realCmd = createInteractiveCommand();
  const globalOpts = command.opts();
  const args: string[] = [];
  if (globalOpts.tui === true) {
    args.push('--tui');
  } else if (globalOpts.tui === false) {
    args.push('--no-tui');
  }
  await realCmd.parseAsync(args, { from: 'user' });
});

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
