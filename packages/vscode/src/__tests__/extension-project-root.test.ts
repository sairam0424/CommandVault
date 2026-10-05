import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';

/**
 * The core vault indexes a project directory only when it is given one (CV-G1-020). The extension
 * used to give it none and rely on the extension host's working directory, which is not the
 * workspace. It now passes the first workspace folder, and nothing when no folder is open.
 */

const mocks = vi.hoisted(() => ({
  createVault: vi.fn(),
  workspaceFolders: undefined as
    readonly { readonly uri: { readonly fsPath: string } }[] | undefined,
}));

vi.mock('vscode', () => {
  const disposable = { dispose: vi.fn() };
  return {
    workspace: {
      getConfiguration: vi
        .fn()
        .mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback }),
      get workspaceFolders() {
        return mocks.workspaceFolders;
      },
      onDidChangeConfiguration: vi.fn().mockReturnValue(disposable),
    },
    window: {
      createTreeView: vi.fn().mockReturnValue({ ...disposable, badge: undefined }),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    languages: {
      registerCompletionItemProvider: vi.fn().mockReturnValue(disposable),
      registerHoverProvider: vi.fn().mockReturnValue(disposable),
      registerDocumentLinkProvider: vi.fn().mockReturnValue(disposable),
    },
  };
});

vi.mock('@commandvault/core', () => ({ createVault: mocks.createVault, Vault: class {} }));
vi.mock('../providers/entries-provider', () => ({ EntriesProvider: vi.fn() }));
vi.mock('../providers/favorites-provider', () => ({ FavoritesProvider: vi.fn() }));
vi.mock('../providers/recent-provider', () => ({ RecentProvider: vi.fn() }));
vi.mock('../providers/completion-provider', () => ({ CompletionProvider: vi.fn() }));
vi.mock('../providers/hover-provider', () => ({ HoverProvider: vi.fn() }));
vi.mock('../providers/link-provider', () => ({ LinkProvider: vi.fn() }));
vi.mock('../commands/index', () => ({ registerCommands: vi.fn().mockReturnValue([]) }));

import { activate, deactivate } from '../extension';

function folder(fsPath: string): { readonly uri: { readonly fsPath: string } } {
  return { uri: { fsPath } };
}

async function activateAndGetVaultConfig(): Promise<Record<string, unknown>> {
  await activate({ subscriptions: [] } as unknown as ExtensionContext);
  expect(mocks.createVault).toHaveBeenCalledTimes(1);
  return mocks.createVault.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.workspaceFolders = undefined;
  mocks.createVault.mockReset();
  mocks.createVault.mockReturnValue({
    on: vi.fn(),
    initialize: vi.fn().mockResolvedValue({ totalEntries: 0 }),
    getStats: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(async () => {
  await deactivate();
});

describe('extension activation and the project directory', () => {
  it('indexes the workspace folder that is open', async () => {
    mocks.workspaceFolders = [folder('/work/repo')];

    const config = await activateAndGetVaultConfig();

    expect(config.projectRoot).toBe('/work/repo');
  });

  it('indexes the first folder of a multi-root workspace', async () => {
    mocks.workspaceFolders = [folder('/work/first'), folder('/work/second')];

    const config = await activateAndGetVaultConfig();

    expect(config.projectRoot).toBe('/work/first');
  });

  it('passes no project directory when no folder is open', async () => {
    mocks.workspaceFolders = undefined;

    const config = await activateAndGetVaultConfig();

    expect(config).not.toHaveProperty('projectRoot');
  });

  it('passes no project directory for a workspace with an empty folder list', async () => {
    mocks.workspaceFolders = [];

    const config = await activateAndGetVaultConfig();

    expect(config).not.toHaveProperty('projectRoot');
  });
});
