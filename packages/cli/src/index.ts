#!/usr/bin/env node

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

const program = new Command();

program
  .name('vault')
  .version('0.1.0')
  .description('CommandVault — terminal companion for managing AI slash commands')
  .option('--claude-path <path>', 'Override ~/.claude config location')
  .option('--tier <tier>', 'Search engine tier (fuse|minisearch|sqlite)');

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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
