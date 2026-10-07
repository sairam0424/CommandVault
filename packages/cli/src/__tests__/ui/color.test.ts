import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ui/color.ts switches chalk off when NO_COLOR is set (and FORCE_COLOR is not). It must be
 * imported fresh per case because it acts at import time.
 *
 * Out of scope here: errors.ts colours stderr through its own chalk import; whether it honours
 * NO_COLOR is covered by the e2e colour test only as far as stdout goes.
 */

async function levelAfterImport(env: Readonly<Record<string, string | undefined>>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { default: chalk } = await import('chalk');
  const before = chalk.level;
  await import('../../ui/color.js');
  return { before, after: chalk.level };
}

describe('ui/color', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets chalk.level to 0 when NO_COLOR is set and FORCE_COLOR is not', async () => {
    const { after } = await levelAfterImport({ NO_COLOR: '1', FORCE_COLOR: undefined });
    expect(after).toBe(0);
  });

  it('leaves the level alone when FORCE_COLOR is also set', async () => {
    const { before, after } = await levelAfterImport({ NO_COLOR: '1', FORCE_COLOR: '1' });
    expect(after).toBe(before);
  });

  it('leaves the level alone when neither is set', async () => {
    const { before, after } = await levelAfterImport({
      NO_COLOR: undefined,
      FORCE_COLOR: undefined,
    });
    expect(after).toBe(before);
  });

  it('treats an empty NO_COLOR as unset', async () => {
    const { before, after } = await levelAfterImport({ NO_COLOR: '', FORCE_COLOR: undefined });
    expect(after).toBe(before);
  });

  it('exposes the decision as a pure function', async () => {
    const { isColorDisabled } = await import('../../ui/color.js');
    expect(isColorDisabled({ NO_COLOR: '1' })).toBe(true);
    expect(isColorDisabled({ NO_COLOR: '1', FORCE_COLOR: '0' })).toBe(false);
    expect(isColorDisabled({})).toBe(false);
    expect(isColorDisabled({ NO_COLOR: '' })).toBe(false);
  });
});
