import { describe, expect, inject, it } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';

/**
 * The vitest config installs test-support/hermetic-home.ts, which gives every worker a throwaway
 * HOME before any test file is imported. Without it these tests would read and write the
 * developer's real ~/.commandvault and ~/.claude.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** The real locations test-support/global-setup.ts watches; see real-home-sentinel.ts. */
    realHomeSentinel: readonly string[];
  }
}

// Captured while this file is being imported, i.e. after the setup file and before any test runs.
const HOME_AT_IMPORT = homedir();

describe('hermetic test environment', () => {
  it('points HOME at a temp directory before any test module is loaded', () => {
    const fromTmp = relative(tmpdir(), HOME_AT_IMPORT);
    expect(fromTmp.startsWith('..') || isAbsolute(fromTmp)).toBe(false);
    expect(homedir()).toBe(HOME_AT_IMPORT);
  });

  it('keeps HOME, USERPROFILE and COMMANDVAULT_HOME inside that directory', () => {
    expect(process.env.HOME).toBe(HOME_AT_IMPORT);
    expect(process.env.USERPROFILE).toBe(HOME_AT_IMPORT);
    expect(process.env.COMMANDVAULT_HOME).toBe(join(HOME_AT_IMPORT, '.commandvault'));
  });

  it('does not inherit a CLAUDE_CONFIG_DIR from the launching shell', () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('runs the real-home sentinel, watching locations outside this HOME', () => {
    // Dropping `globalSetup` from test-support/vitest-options.ts would silently disarm the guard
    // that fails a run touching the real ~/.commandvault or ~/.claude: nothing else would notice.
    const watched = inject('realHomeSentinel');

    expect(watched).toBeDefined();
    expect(watched.map((path) => basename(path))).toEqual(
      expect.arrayContaining(['.commandvault', '.claude']),
    );
    for (const path of watched) {
      expect(relative(HOME_AT_IMPORT, path).startsWith('..'), path).toBe(true);
    }
  });

  it('starts with neither a Claude nor a CommandVault directory in HOME', () => {
    expect(existsSync(join(HOME_AT_IMPORT, '.claude'))).toBe(false);
    expect(existsSync(join(HOME_AT_IMPORT, '.commandvault'))).toBe(false);
  });
});
