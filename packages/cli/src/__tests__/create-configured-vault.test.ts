import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const createVault = vi.fn((config: unknown) => ({ config }));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  createVault,
}));

/** Every command opens its vault through createConfiguredVault, so none can skip config.json. */
describe('createConfiguredVault', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-configured-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, 'data'));
    createVault.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig(config: unknown): Promise<void> {
    await mkdir(join(home, 'data'), { recursive: true });
    await writeFile(join(home, 'data', 'config.json'), JSON.stringify(config));
  }

  it('passes the project root and the watcher switch through', async () => {
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({ project: '/some/project' }, true);
    expect(createVault).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/some/project', enableWatcher: true }),
    );
  });

  it('leaves the project root unset when --project was not given', async () => {
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({}, false);
    const config = createVault.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['projectRoot']).toBeUndefined();
    expect(config['enableWatcher']).toBe(false);
  });

  it('takes the Claude directory and the tier from config.json when no flag is given', async () => {
    await writeConfig({ claudeConfigPath: '/from/config', searchTier: 'sqlite' });
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({}, true);
    expect(createVault).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfigPath: '/from/config', defaultSearchTier: 'sqlite' }),
    );
  });

  it('lets the flags win over config.json', async () => {
    await writeConfig({ claudeConfigPath: '/from/config', searchTier: 'sqlite' });
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({ claudePath: '/from/flag', tier: 'fuse' }, false);
    expect(createVault).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfigPath: '/from/flag', defaultSearchTier: 'fuse' }),
    );
  });

  it('rejects an invalid searchTier in config.json before any vault is built', async () => {
    await writeConfig({ searchTier: 'bogus' });
    const { createConfiguredVault } = await import('../helpers.js');
    await expect(createConfiguredVault({}, true)).rejects.toMatchObject({ exitCode: 2 });
    expect(createVault).not.toHaveBeenCalled();
  });

  it('keeps the index in the data directory unless a database path is given', async () => {
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({}, false);
    const config = createVault.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('dbPath' in config).toBe(false);
  });

  it('passes a database path override on to the vault', async () => {
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({}, false, { dbPath: '/scratch/vault.db' });
    expect(createVault).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/scratch/vault.db' }),
    );
  });

  it('uses a config the caller already loaded instead of reading config.json again', async () => {
    await writeConfig({ claudeConfigPath: '/from/file' });
    const { createConfiguredVault } = await import('../helpers.js');
    await createConfiguredVault({}, false, { config: { claudeConfigPath: '/preloaded' } });
    expect(createVault).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfigPath: '/preloaded' }),
    );
  });
});

describe('claudeDirFor', () => {
  it('prefers the flag, then config.json, then the environment default', async () => {
    const { claudeDirFor } = await import('../helpers.js');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/from/env');
    try {
      // claudeDirFor resolves whatever it picks, and on Windows resolve() puts the current drive
      // in front of a root-relative path ('/flag' becomes 'D:\flag'), so compare resolved forms.
      expect(claudeDirFor({ claudePath: '/flag' }, { claudeConfigPath: '/config' })).toBe(
        resolve('/flag'),
      );
      expect(claudeDirFor({}, { claudeConfigPath: '/config' })).toBe(resolve('/config'));
      expect(claudeDirFor({}, {})).toBe(resolve('/from/env'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns an absolute path', async () => {
    const { claudeDirFor } = await import('../helpers.js');
    expect(claudeDirFor({ claudePath: 'relative/dir' }, {})).toBe(
      join(process.cwd(), 'relative', 'dir'),
    );
  });
});
