import { fileURLToPath } from 'node:url';

/**
 * The `test` options every package's vitest config spreads in to make its tests hermetic:
 * a throwaway HOME per worker, and a global sentinel that fails the run if the real
 * ~/.commandvault or ~/.claude changed. `forks` is required, see hermetic-home.ts.
 */
export const hermeticTestOptions = {
  pool: 'forks',
  globalSetup: [fileURLToPath(new URL('./global-setup.ts', import.meta.url))],
  setupFiles: [fileURLToPath(new URL('./hermetic-home.ts', import.meta.url))],
} as const;
