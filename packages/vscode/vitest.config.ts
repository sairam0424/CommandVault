import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { hermeticTestOptions } from '../../test-support/vitest-options.js';

export default defineConfig({
  test: {
    ...hermeticTestOptions,
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
    // Each file's first dynamic import of a webview module after vi.resetModules() is transformed by
    // vite-node and pays the cold load of @commandvault/core (see packages/cli/vitest.config.ts);
    // on a loaded machine that took 2-6 s against vitest's 5 s default. Test and hook budgets are
    // kept equal so a case does not fail depending on whether its import sits in the body or in a
    // hook. No vscode test asserts wall-clock speed (its toBeLessThan compare lengths and indices).
    testTimeout: 30_000,
    // detail-panel's beforeEach does that import inside the hook and the 10 s hook default expired
    // there (10014-10017 ms in nine gate logs while the same tree passed on GitHub runners).
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
    },
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
