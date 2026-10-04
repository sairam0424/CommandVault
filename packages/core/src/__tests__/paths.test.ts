import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveClaudeDir, resolveDataDir } from '../paths.js';

/**
 * Both resolvers are evaluated at CALL time. The module-level constants they replace captured
 * `homedir()` when the package was imported, so setting HOME or COMMANDVAULT_HOME afterwards
 * had no effect (CV-G2-094).
 */

interface ResolverCase {
  readonly name: string;
  readonly resolver: (env?: Readonly<Record<string, string | undefined>>) => string;
  readonly variable: string;
  readonly folder: string;
}

const RESOLVERS: readonly ResolverCase[] = [
  {
    name: 'resolveDataDir',
    resolver: resolveDataDir,
    variable: 'COMMANDVAULT_HOME',
    folder: '.commandvault',
  },
  {
    name: 'resolveClaudeDir',
    resolver: resolveClaudeDir,
    variable: 'CLAUDE_CONFIG_DIR',
    folder: '.claude',
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(RESOLVERS)('$name', ({ resolver, variable, folder }) => {
  it('falls back to a folder in the home directory when the variable is absent', () => {
    expect(resolver({})).toBe(join(homedir(), folder));
  });

  it('uses the variable when it is set', () => {
    const custom = join(tmpdir(), 'cv-paths', 'custom');
    expect(resolver({ [variable]: custom })).toBe(custom);
  });

  it.each(['', ' ', '\t\n'])('treats %j as unset', (blank) => {
    expect(resolver({ [variable]: blank })).toBe(join(homedir(), folder));
  });

  it('trims surrounding whitespace from the variable', () => {
    const custom = join(tmpdir(), 'cv-paths', 'padded');
    expect(resolver({ [variable]: `  ${custom}\n` })).toBe(custom);
  });

  it('resolves a relative value against the current directory', () => {
    expect(resolver({ [variable]: join('relative', 'dir') })).toBe(resolve('relative', 'dir'));
  });

  it('normalises dot segments into an absolute path', () => {
    const value = `${join(tmpdir(), 'cv-paths', 'a')}/../b`;
    expect(resolver({ [variable]: value })).toBe(join(tmpdir(), 'cv-paths', 'b'));
  });

  it('expands a leading ~/ against the home directory', () => {
    expect(resolver({ [variable]: '~/elsewhere/dir' })).toBe(join(homedir(), 'elsewhere', 'dir'));
  });

  it('expands a bare ~ to the home directory', () => {
    expect(resolver({ [variable]: '~' })).toBe(homedir());
  });

  it('leaves a tilde that is not a leading ~/ alone', () => {
    expect(resolver({ [variable]: '~someone/dir' })).toBe(resolve('~someone/dir'));
    const inner = join(tmpdir(), '~', 'dir');
    expect(resolver({ [variable]: inner })).toBe(inner);
  });

  it.each(['x', '.', 'a/b'])(
    'does not read %j as a home shorthand: only ~ or ~/ opens one',
    (value) => {
      // A one-character value is as long as the `~` prefix, and `a/b` has a separator right after
      // its first character: neither may be mistaken for `~` or `~/...` and expand to the home dir.
      expect(resolver({ [variable]: value })).toBe(resolve(value));
    },
  );

  it('reads process.env at call time when no env is passed', () => {
    const first = join(tmpdir(), 'cv-paths', 'first');
    const second = join(tmpdir(), 'cv-paths', 'second');

    vi.stubEnv(variable, first);
    expect(resolver()).toBe(first);

    vi.stubEnv(variable, second);
    expect(resolver()).toBe(second);

    vi.stubEnv(variable, '');
    expect(resolver()).toBe(join(homedir(), folder));
  });

  it('follows HOME when the variable is absent, evaluated at call time', () => {
    const fakeHome = join(tmpdir(), 'cv-paths', 'fake-home');
    vi.stubEnv(variable, '');
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);

    expect(resolver()).toBe(join(fakeHome, folder));
  });

  it('treats a HOME that is set but empty like an unset one and stays absolute', () => {
    // `os.homedir()` returns '' (not the passwd home) for an empty HOME, which used to yield the
    // relative path `.commandvault` and so a vault written into whatever directory the CLI ran in.
    vi.stubEnv(variable, '');
    vi.stubEnv('HOME', '');
    vi.stubEnv('USERPROFILE', '');

    if (process.platform !== 'win32') expect(homedir()).toBe('');
    expect(isAbsolute(resolver())).toBe(true);
    expect(resolver()).toBe(join(userInfo().homedir, folder));
    expect(resolver({ [variable]: '~/elsewhere' })).toBe(join(userInfo().homedir, 'elsewhere'));
  });

  it('prefers an explicit env object over process.env', () => {
    const fromProcess = join(tmpdir(), 'cv-paths', 'from-process');
    const fromArgument = join(tmpdir(), 'cv-paths', 'from-argument');
    vi.stubEnv(variable, fromProcess);

    expect(resolver({ [variable]: fromArgument })).toBe(fromArgument);
  });
});

describe('the two resolvers are independent', () => {
  it('COMMANDVAULT_HOME does not move the Claude directory, and the reverse', () => {
    const env = {
      COMMANDVAULT_HOME: join(tmpdir(), 'cv-paths', 'data'),
      CLAUDE_CONFIG_DIR: join(tmpdir(), 'cv-paths', 'claude'),
    };
    expect(resolveDataDir({ COMMANDVAULT_HOME: env.COMMANDVAULT_HOME })).toBe(
      env.COMMANDVAULT_HOME,
    );
    expect(resolveClaudeDir({ COMMANDVAULT_HOME: env.COMMANDVAULT_HOME })).toBe(
      join(homedir(), '.claude'),
    );
    expect(resolveDataDir({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR })).toBe(
      join(homedir(), '.commandvault'),
    );
  });
});

describe('when os.homedir() itself throws', () => {
  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('falls back to the account home instead of throwing (Windows without USERPROFILE)', async () => {
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      homedir: () => {
        throw new Error('uv_os_homedir returned ENOENT (no such file or directory)');
      },
    }));
    const paths = await import('../paths.js');

    expect(paths.resolveDataDir({})).toBe(join(userInfo().homedir, '.commandvault'));
    expect(paths.resolveClaudeDir({})).toBe(join(userInfo().homedir, '.claude'));
  });
});
