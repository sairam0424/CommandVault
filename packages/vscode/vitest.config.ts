import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { hermeticTestOptions } from '../../test-support/vitest-options.js';

export default defineConfig({
  test: {
    ...hermeticTestOptions,
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
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
