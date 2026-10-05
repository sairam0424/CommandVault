import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MOCK_STATS } from './fixtures/mock-vault.js';

/**
 * The lazily loaded commands never see the root program's options, so index.ts re-sends them as
 * argv. These tests run the real index.ts in process and observe what the Vault and the
 * interactive command receive. (The built-binary tests cannot: core only honours `projectRoot`
 * once lane L1d lands, so until then the directory is invisible in the output.)
 */

const createVault = vi.fn((_config: unknown) => ({
  initialize: async () => MOCK_STATS,
  getAllEntries: () => [],
  dispose: async () => {},
}));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  createVault,
}));

/** index.ts starts itself on import; capture the run instead of exiting the test process. */
let cliRun: Promise<unknown> | undefined;
vi.mock('../errors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../errors.js')>()),
  installProcessHandlers: () => {},
  runCli: (run: () => Promise<unknown>) => {
    cliRun = run();
  },
}));

let interactiveOptions: Record<string, unknown> | undefined;
vi.mock('../commands/interactive.js', () => ({
  createInteractiveCommand: () =>
    new Command('interactive')
      .option('--tui')
      .option('--no-tui')
      .action((_opts: unknown, command: Command) => {
        interactiveOptions = command.optsWithGlobals();
      }),
}));

describe('index.ts forwards --project and the other global options', () => {
  let root: string;
  let projectDir: string;
  const originalArgv = process.argv;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'vault-forwarding-test-')));
    projectDir = join(root, 'proj');
    await mkdir(projectDir);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('COMMANDVAULT_HOME', join(root, 'data'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    createVault.mockClear();
    cliRun = undefined;
    interactiveOptions = undefined;
  });

  afterEach(async () => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function runVault(...args: string[]): Promise<void> {
    process.argv = ['node', 'vault', ...args];
    await import('../index.js');
    await cliRun;
  }

  function vaultConfig(): Record<string, unknown> {
    expect(createVault).toHaveBeenCalledTimes(1);
    return createVault.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it('sends a directory given after a lazily loaded command to the Vault', async () => {
    await runVault('list', '--json', '--project', projectDir);
    expect(vaultConfig()['projectRoot']).toBe(projectDir);
  });

  it('sends a directory given before the command to the Vault', async () => {
    await runVault('--project', projectDir, 'list', '--json');
    expect(vaultConfig()['projectRoot']).toBe(projectDir);
  });

  it('sends a bare --project to the Vault as the current directory', async () => {
    await runVault('list', '--json', '--project');
    expect(vaultConfig()['projectRoot']).toBe(process.cwd());
  });

  it('leaves projectRoot unset without --project', async () => {
    await runVault('list', '--json');
    expect(vaultConfig()['projectRoot']).toBeUndefined();
  });

  it.each([
    ['vault interactive', ['interactive']],
    ['the bare vault', []],
  ])('hands %s the directory and the other globals, before or after', async (_name, prefix) => {
    await runVault(...prefix, '--project', projectDir, '--tier', 'fuse', '--json', '--no-tui');
    expect(interactiveOptions).toMatchObject({
      project: projectDir,
      tier: 'fuse',
      json: true,
      tui: false,
    });
  });

  it('hands the interactive command a bare --project as the current directory', async () => {
    await runVault('interactive', '--project');
    expect(interactiveOptions).toMatchObject({ project: process.cwd() });
  });
});
