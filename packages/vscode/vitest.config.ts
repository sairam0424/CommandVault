import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
