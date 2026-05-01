import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, readdir, readFile, constants } from 'node:fs/promises';
import { createVaultInstance, type CliGlobalOptions } from '../helpers.js';

interface CheckResult {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function countItems(dirPath: string): Promise<number> {
  try {
    const items = await readdir(dirPath);
    return items.length;
  } catch {
    return 0;
  }
}

async function isValidJson(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function settingsHasHooks(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return 'hooks' in parsed;
  } catch {
    return false;
  }
}

function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  const passed = major >= 20;

  return {
    label: 'Node.js version',
    passed,
    detail: passed ? `v${version} (>= 20 required)` : `v${version} — Node.js 20+ is required`,
  };
}

async function checkClaudeDir(): Promise<CheckResult> {
  const claudePath = join(homedir(), '.claude');
  const exists = await fileExists(claudePath);

  return {
    label: '~/.claude/ directory',
    passed: exists,
    detail: exists
      ? 'Directory exists and is readable'
      : 'Directory not found — install Claude Code first',
  };
}

async function checkSkillsDir(): Promise<CheckResult> {
  const skillsPath = join(homedir(), '.claude', 'skills');
  const exists = await fileExists(skillsPath);

  if (!exists) {
    return {
      label: '~/.claude/skills/',
      passed: false,
      detail: 'Directory not found',
    };
  }

  const count = await countItems(skillsPath);
  return {
    label: '~/.claude/skills/',
    passed: true,
    detail: `${count} skill${count === 1 ? '' : 's'} found`,
  };
}

async function checkAgentsDir(): Promise<CheckResult> {
  const agentsPath = join(homedir(), '.claude', 'agents');
  const exists = await fileExists(agentsPath);

  if (!exists) {
    return {
      label: '~/.claude/agents/',
      passed: false,
      detail: 'Directory not found',
    };
  }

  const count = await countItems(agentsPath);
  return {
    label: '~/.claude/agents/',
    passed: true,
    detail: `${count} agent${count === 1 ? '' : 's'} found`,
  };
}

async function checkCommandsDir(): Promise<CheckResult> {
  const commandsPath = join(homedir(), '.claude', 'commands');
  const exists = await fileExists(commandsPath);

  if (!exists) {
    return {
      label: '~/.claude/commands/',
      passed: false,
      detail: 'Directory not found',
    };
  }

  const count = await countItems(commandsPath);
  return {
    label: '~/.claude/commands/',
    passed: true,
    detail: `${count} command${count === 1 ? '' : 's'} found`,
  };
}

async function checkInstalledPlugins(): Promise<CheckResult> {
  const pluginsPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const exists = await fileExists(pluginsPath);

  if (!exists) {
    return {
      label: 'installed_plugins.json',
      passed: false,
      detail: 'File not found at ~/.claude/plugins/installed_plugins.json',
    };
  }

  const isValid = await isValidJson(pluginsPath);
  return {
    label: 'installed_plugins.json',
    passed: isValid,
    detail: isValid ? 'Valid JSON' : 'File exists but contains invalid JSON',
  };
}

async function checkSettingsJson(): Promise<CheckResult> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const exists = await fileExists(settingsPath);

  if (!exists) {
    return {
      label: 'settings.json',
      passed: false,
      detail: 'File not found at ~/.claude/settings.json',
    };
  }

  const hasHooks = await settingsHasHooks(settingsPath);
  return {
    label: 'settings.json',
    passed: true,
    detail: hasHooks ? 'Valid with hooks section' : 'Valid but no hooks section found',
  };
}

async function checkCommandVaultDir(): Promise<CheckResult> {
  const vaultPath = join(homedir(), '.commandvault');
  const exists = await fileExists(vaultPath);

  return {
    label: '~/.commandvault/ directory',
    passed: exists,
    detail: exists ? 'Directory exists' : 'Not found — run `vault init` first',
  };
}

async function checkVaultDb(): Promise<CheckResult> {
  const dbPath = join(homedir(), '.commandvault', 'vault.db');
  const exists = await fileExists(dbPath);

  return {
    label: '~/.commandvault/vault.db',
    passed: exists,
    detail: exists ? 'SQLite database exists' : 'Not found — run `vault list` to create it',
  };
}

export function createDoctorCommand(): Command {
  const cmd = new Command('doctor')
    .description('Check system health and diagnose configuration issues')
    .action(async (_opts, command) => {
      const globalOpts = command.optsWithGlobals() as CliGlobalOptions;

      console.log('');
      console.log(chalk.bold.white('  CommandVault Doctor'));
      console.log(chalk.dim('  ' + '='.repeat(40)));
      console.log('');

      // Run static checks
      const staticChecks: CheckResult[] = [
        checkNodeVersion(),
        ...(await Promise.all([
          checkClaudeDir(),
          checkSkillsDir(),
          checkAgentsDir(),
          checkCommandsDir(),
          checkInstalledPlugins(),
          checkSettingsJson(),
          checkCommandVaultDir(),
          checkVaultDb(),
        ])),
      ];

      for (const check of staticChecks) {
        const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
        const label = check.passed ? chalk.white(check.label) : chalk.red(check.label);
        const detail = check.passed ? chalk.dim(check.detail) : chalk.yellow(check.detail);

        console.log(`  ${icon}  ${label}  ${detail}`);
      }

      // Run vault scan check with spinner
      console.log('');
      const spinner = ora({ text: 'Testing vault scan pipeline...', indent: 2 }).start();

      let scanResult: CheckResult;

      try {
        const vault = await createVaultInstance(globalOpts);

        try {
          const entries = vault.getAllEntries();
          spinner.stop();

          scanResult = {
            label: 'Vault scan pipeline',
            passed: true,
            detail: `Scanned ${entries.length} entries successfully`,
          };
        } finally {
          await vault.dispose();
        }
      } catch (error) {
        spinner.stop();

        const message = error instanceof Error ? error.message : String(error);
        scanResult = {
          label: 'Vault scan pipeline',
          passed: false,
          detail: `Scan failed: ${message}`,
        };
      }

      const scanIcon = scanResult.passed ? chalk.green('✓') : chalk.red('✗');
      const scanLabel = scanResult.passed
        ? chalk.white(scanResult.label)
        : chalk.red(scanResult.label);
      const scanDetail = scanResult.passed
        ? chalk.dim(scanResult.detail)
        : chalk.yellow(scanResult.detail);

      console.log(`  ${scanIcon}  ${scanLabel}  ${scanDetail}`);

      // Summary
      const allChecks = [...staticChecks, scanResult];
      const passedCount = allChecks.filter((c) => c.passed).length;
      const totalCount = allChecks.length;
      const allPassed = passedCount === totalCount;

      console.log('');
      console.log(chalk.dim('  ' + '-'.repeat(40)));

      if (allPassed) {
        console.log(chalk.green.bold(`  ${passedCount}/${totalCount} checks passed — all good!`));
      } else {
        console.log(chalk.yellow.bold(`  ${passedCount}/${totalCount} checks passed`));

        const failedChecks = allChecks.filter((c) => !c.passed);
        console.log('');
        console.log(chalk.white('  Issues to resolve:'));

        for (const check of failedChecks) {
          console.log(`    ${chalk.red('✗')} ${check.label}: ${chalk.yellow(check.detail)}`);
        }
      }

      console.log('');
    });

  return cmd;
}
