import { defineConfig } from 'vitest/config';
import { hermeticTestOptions } from '../../test-support/vitest-options.js';

export default defineConfig({
  test: {
    ...hermeticTestOptions,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/types/**'],
      thresholds: {
        lines: 80,
        functions: 75,
        branches: 70,
        statements: 80,
      },
    },
  },
});
