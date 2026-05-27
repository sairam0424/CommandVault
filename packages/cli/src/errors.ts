import chalk from 'chalk';
import type { Vault } from '@commandvault/core';
import { createVaultInstance, type CliGlobalOptions } from './helpers.js';

export const EXIT_SUCCESS = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_NETWORK_ERROR = 3;

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_USER_ERROR,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export async function withCommand<T>(
  fn: (vault: Vault) => Promise<T>,
  options?: { claudePath?: string; tier?: string; skipVault?: boolean },
): Promise<T> {
  const globalOpts: CliGlobalOptions = {
    claudePath: options?.claudePath,
    tier: options?.tier as CliGlobalOptions['tier'],
  };

  try {
    const vault = await createVaultInstance(globalOpts);
    try {
      return await fn(vault);
    } finally {
      await vault.dispose();
    }
  } catch (error) {
    if (error instanceof CommandError) {
      console.error(chalk.red(error.message));
      process.exit(error.exitCode);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Unexpected error: ${message}`));
    process.exit(EXIT_USER_ERROR);
  }
}
