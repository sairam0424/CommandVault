import { defineConfig } from 'vitest/config';
import { hermeticTestOptions } from '../../test-support/vitest-options.js';

export default defineConfig({
  test: {
    ...hermeticTestOptions,
    // Ten test files open a database that needs migrating (safety copy, migrations, full-text
    // rebuild, switch to write-ahead logging). Ubuntu does that in well under a second; the Windows
    // runner takes 5 to 7 s (runs 37543877412 and 37574554995), so vitest's 5 s unit-test default
    // cut off whichever case drew the slow run. The adapter's own busy timeout is 10 s, so 30 s
    // still catches a hang while a slow but correct open passes. Speed assertions keep their own
    // explicit budgets; this is only the hang detector.
    testTimeout: 30_000,
    // Hooks do database work too: legacy-db-upgrade's beforeEach builds a 0.1.0-shaped fixture with
    // better-sqlite3 directly, other suites open or migrate one. vitest budgets hooks separately,
    // and the 10 s default expired on the Windows runner (develop push runs 37584602434, 37585716433,
    // 37585910995) right after the test budget was raised, while the same trees passed as PRs.
    hookTimeout: 30_000,
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
