import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
