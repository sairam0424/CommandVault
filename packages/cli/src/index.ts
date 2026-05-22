#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { createListCommand } from './commands/list.js';
import { createSearchCommand } from './commands/search.js';
import { createInfoCommand } from './commands/info.js';
import { createStatsCommand } from './commands/stats.js';
import { createExportCommand } from './commands/export-cmd.js';
import { createFavoriteCommand } from './commands/favorite.js';
import { createInitCommand } from './commands/init.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createImportCommand } from './commands/import-cmd.js';
import { createSyncCommand } from './commands/sync.js';
import { createTagCommand } from './commands/tag.js';
import { createDiffCommand } from './commands/diff.js';
import { createWatchCommand } from './commands/watch.js';
import { createOpenCommand } from './commands/open.js';
import { createRunCommand } from './commands/run.js';
import { createBackupCommand } from './commands/backup.js';
import { createRestoreCommand } from './commands/restore.js';
import { createConfigCommand } from './commands/config.js';
import { createCompletionsCommand } from './commands/completions.js';
import { createRegistryCommand } from './commands/registry.js';
import { createAuditCommand } from './commands/audit.js';

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

program.addCommand(createListCommand());
program.addCommand(createSearchCommand());
program.addCommand(createInfoCommand());
program.addCommand(createStatsCommand());
program.addCommand(createExportCommand());
program.addCommand(createFavoriteCommand());
program.addCommand(createInitCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createImportCommand());
program.addCommand(createSyncCommand());
program.addCommand(createTagCommand());
program.addCommand(createDiffCommand());
program.addCommand(createWatchCommand());
// Interactive command is lazy-loaded because it imports heavy deps (@inquirer/prompts, ink, react)
const interactiveCmd = new Command('interactive')
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
program.addCommand(interactiveCmd);
program.addCommand(createOpenCommand());
program.addCommand(createRunCommand());
program.addCommand(createBackupCommand());
program.addCommand(createRestoreCommand());
program.addCommand(createConfigCommand());
program.addCommand(createCompletionsCommand());
program.addCommand(createRegistryCommand());
program.addCommand(createAuditCommand());

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
