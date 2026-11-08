import { describe, expect, it } from 'vitest';
import { NativeAddonUnavailableError } from '../indexer/db-errors.js';

const DB_PATH = '/tmp/commandvault-test/vault.db';

function messageFor(loaderText: string): string {
  return new NativeAddonUnavailableError(DB_PATH, new Error(loaderText)).message;
}

describe('the ABI numbers in a native add-on load error', () => {
  it('names the built and the running ABI from the first two mentions', () => {
    const message = messageFor(
      'compiled against NODE_MODULE_VERSION 115. This requires NODE_MODULE_VERSION 131.',
    );
    expect(message).toContain('built for Node ABI 115');
    expect(message).toContain('(ABI 131)');
  });

  it('ignores any further mentions', () => {
    const message = messageFor(
      'NODE_MODULE_VERSION 115, then NODE_MODULE_VERSION 131, then NODE_MODULE_VERSION 137',
    );
    expect(message).toContain('built for Node ABI 115');
    expect(message).toContain('(ABI 131)');
    expect(message).not.toContain('137');
  });

  it('claims no built ABI when the loader names only one', () => {
    const message = messageFor('NODE_MODULE_VERSION 115 and nothing else');
    expect(message).not.toMatch(/built for Node ABI/);
    expect(message).toContain(`(ABI ${process.versions.modules})`);
  });

  it(
    'reads a message that is long and has nothing to match in linear time',
    { timeout: 20_000 },
    () => {
      const hostile = `NODE_MODULE_VERSION ${'9'.repeat(240_000)}`;

      const started = performance.now();
      const message = messageFor(hostile);
      const elapsedMs = performance.now() - started;

      expect(message).not.toMatch(/built for Node ABI/);
      expect(elapsedMs).toBeLessThan(500);
    },
  );
});
