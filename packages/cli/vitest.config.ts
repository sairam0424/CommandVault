import { defineConfig } from 'vitest/config';
import { hermeticTestOptions } from '../../test-support/vitest-options.js';

export default defineConfig({
  test: {
    ...hermeticTestOptions,
    fileParallelism: false,
    // The first test in a file that imports the CLI pays the cold load of @commandvault/core through
    // vite-node: the workspace link resolves outside node_modules, so every one of its dist modules
    // is inlined and transformed with one RPC to the main process each. config.test's 'loads a valid
    // config file' measured 2.1-5.8 s in 15 gate runs on a loaded machine (the same import after
    // vi.resetModules() takes 0.3-0.8 s) and crossed vitest's 5 s default in 5 of them. The e2e
    // files keep their own 60 s setConfig; the harness's 30 s spawn timeout stays the hang detector
    // per CLI call. No cli test asserts wall-clock speed, so nothing is loosened by this.
    testTimeout: 30_000,
    // vitest budgets hooks separately and the 10 s default expired in tui App.batched-input's
    // afterEach cleanup() under the same load; hooks pay the same cold-import and jsdom costs.
    hookTimeout: 30_000,
    environmentMatchGlobs: [
      ['src/__tests__/tui/**', 'jsdom'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
    },
  },
});
