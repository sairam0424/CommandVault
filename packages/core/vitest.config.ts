import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/types/**'],
      // Measured floor on a runner with no ~/.claude (79.32% lines/statements). The old 80%
      // never gated anything because the coverage run crashed before it could be checked.
      thresholds: {
        lines: 79,
        functions: 75,
        branches: 70,
        statements: 79,
      },
    },
  },
});
