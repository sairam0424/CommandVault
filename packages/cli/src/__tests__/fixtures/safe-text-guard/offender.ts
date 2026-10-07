import chalk from 'chalk';
import type { Vault, VaultEntry } from '@commandvault/core';

/**
 * Self-test fixture for safe-text-guard.test.ts: exactly three uncleared tainted reads, one bare,
 * one wrapped in a call that is not a sanitiser, and one sanitising-call result left bare.
 */
export function leak(entry: VaultEntry, vault: Vault): void {
  console.log(entry.name);
  console.log(chalk.red(entry.description));
  vault.getSlashCommand(entry);
}
