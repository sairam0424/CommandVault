import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultEntry } from '@commandvault/core';
import { commands, window, workspace } from 'vscode';
import { registerCommands } from '../commands/index';
import { MOCK_ENTRIES } from './fixtures/mock-entries';
import { HOSTILE_NOTIFICATION_TEXTS } from './helpers/hostile-text';
import { expectShownNotificationsInert, shownNotifications } from './helpers/notification-links';

/**
 * VS Code 1.138 draws `[label](command:...)` in a notification as a button that runs the command.
 * An entry's name, its slash command, its file path and whatever an error says about them are
 * supplied by plugins and cloned repositories, so none of the toasts the commands show may carry
 * them as link syntax.
 */

const HOSTILE = Object.entries(HOSTILE_NOTIFICATION_TEXTS);

type Handler = (argument?: unknown) => unknown;

function fakeVault(overrides: Record<string, unknown> = {}) {
  return {
    toggleFavorite: vi.fn().mockReturnValue(true),
    getSlashCommand: vi.fn((entry: VaultEntry) => `/${entry.name}`),
    recordUsage: vi.fn(),
    scan: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({
      totalEntries: 2,
      favoriteCount: 1,
      lastScanAt: new Date(0),
      byType: { command: 2 },
      bySource: { custom: 2 },
    }),
    getAllEntries: vi.fn().mockReturnValue([MOCK_ENTRIES[0]]),
    search: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

/** The handlers `registerCommands` registered, by command id. */
function registerHandlers(vault = fakeVault()): Readonly<Record<string, Handler>> {
  const provider = { refresh: vi.fn() } as never;
  registerCommands({ subscriptions: [] } as never, vault as never, provider, provider, provider);
  const calls = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls;
  return Object.fromEntries(calls.map(([id, handler]) => [id, handler as Handler]));
}

function entryNamed(name: string, filePath = MOCK_ENTRIES[0].filePath): VaultEntry {
  return { ...MOCK_ENTRIES[0], name, filePath };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('commands: a toast about an entry carries no link syntax from its name', () => {
  it.each(HOSTILE)('%s as the name of a favourited entry', (_n, text) => {
    registerHandlers()['commandvault.toggleFavorite'](entryNamed(text));

    expectShownNotificationsInert();
  });

  it.each(HOSTILE)('%s as the name of an entry taken out of the favourites', (_n, text) => {
    const vault = fakeVault({ toggleFavorite: vi.fn().mockReturnValue(false) });

    registerHandlers(vault)['commandvault.toggleFavorite'](entryNamed(text));

    expectShownNotificationsInert();
  });

  it.each(HOSTILE)('%s as the name of an entry in a tree node', (_n, text) => {
    registerHandlers()['commandvault.toggleFavorite']({ entry: entryNamed(text) });

    expectShownNotificationsInert();
  });

  it.each(HOSTILE)('%s as the slash command that was copied', async (_n, text) => {
    await registerHandlers()['commandvault.copyCommand'](entryNamed(text));

    expectShownNotificationsInert();
  });

  it.each(HOSTILE)('%s as the slash command that was inserted', (_n, text) => {
    registerHandlers()['commandvault.insertToTerminal'](entryNamed(text));

    expectShownNotificationsInert();
  });
});

describe('commands: a toast about a failure carries no link syntax from the error', () => {
  it.each(HOSTILE)('%s in the reason a refresh failed', async (_n, text) => {
    const vault = fakeVault({ scan: vi.fn().mockRejectedValue(new Error(`cannot read ${text}`)) });

    await registerHandlers(vault)['commandvault.refresh']();

    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expectShownNotificationsInert();
  });

  it('copes with a refresh that failed with something that is not an Error', async () => {
    const vault = fakeVault({
      scan: vi.fn().mockRejectedValue(HOSTILE_NOTIFICATION_TEXTS.commandLink),
    });

    await registerHandlers(vault)['commandvault.refresh']();

    expectShownNotificationsInert();
  });

  it.each(HOSTILE)(
    '%s in the path and the error of a file that would not open',
    async (_n, text) => {
      (workspace.openTextDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error(`Unable to open '${text}'`), { code: 'EACCES' }),
      );

      await registerHandlers()['commandvault.openFile'](entryNamed('review', `/home/user/${text}`));

      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expectShownNotificationsInert();
    },
  );

  it('names only the error code of a file that would not open', async () => {
    (workspace.openTextDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error(`Unable to open '${HOSTILE_NOTIFICATION_TEXTS.commandLink}'`), {
        code: 'ENOENT',
      }),
    );

    await registerHandlers()['commandvault.openFile'](entryNamed('review'));

    expect(shownNotifications()).toEqual(['CommandVault: Could not open file (ENOENT)']);
  });
});

describe('commands: a toast about an export carries no link syntax from the chosen path', () => {
  it.each(HOSTILE)('%s as a folder of the save location', async (_n, text) => {
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fsPath: `/home/user/${text}/export.json`,
    });

    await registerHandlers()['commandvault.export']();

    expect(workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    expectShownNotificationsInert();
  });
});

describe('commands: the toasts still say what happened', () => {
  it('says an entry was added to and removed from the favourites', () => {
    const vault = fakeVault();
    const toggle = registerHandlers(vault)['commandvault.toggleFavorite'];

    toggle(entryNamed('review'));
    vault.toggleFavorite.mockReturnValue(false);
    toggle(entryNamed('review'));

    expect(shownNotifications()).toEqual([
      'CommandVault: "review" added to favorites',
      'CommandVault: "review" removed from favorites',
    ]);
  });

  it('says what was copied and what was inserted', async () => {
    const handlers = registerHandlers();

    await handlers['commandvault.copyCommand'](entryNamed('review'));
    handlers['commandvault.insertToTerminal'](entryNamed('review'));

    expect(shownNotifications()).toEqual([
      'CommandVault: Copied "/review" to clipboard',
      'CommandVault: Inserted "/review" into terminal',
    ]);
  });

  it('shows the name of an entry as it is, parentheses and all', async () => {
    const handlers = registerHandlers();

    handlers['commandvault.toggleFavorite'](entryNamed('deploy (copy)'));
    await handlers['commandvault.copyCommand'](entryNamed('deploy (copy)'));
    handlers['commandvault.insertToTerminal'](entryNamed('deploy (copy)'));

    expect(shownNotifications()).toEqual([
      'CommandVault: "deploy (copy)" added to favorites',
      'CommandVault: Copied "/deploy (copy)" to clipboard',
      'CommandVault: Inserted "/deploy (copy)" into terminal',
    ]);
  });

  it('says the vault was refreshed, and that a refresh failed and why', async () => {
    const vault = fakeVault();
    const handlers = registerHandlers(vault);

    await handlers['commandvault.refresh']();
    vault.scan.mockRejectedValueOnce(new Error('database is locked'));
    await handlers['commandvault.refresh']();

    expect(shownNotifications()).toEqual([
      'CommandVault: Vault refreshed',
      'CommandVault: Refresh failed - database is locked',
    ]);
  });

  it('shows a Windows path as it is, without doubling its backslashes', async () => {
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fsPath: 'C:\\Users\\me\\export.json',
    });

    await registerHandlers()['commandvault.export']();

    expect(shownNotifications()).toEqual([
      'CommandVault: Exported 1 entries to C:\\Users\\me\\export.json',
    ]);
  });

  it('says where an export went', async () => {
    (window.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fsPath: '/home/user/export.json',
    });

    await registerHandlers()['commandvault.export']();

    expect(shownNotifications()).toEqual([
      'CommandVault: Exported 1 entries to /home/user/export.json',
    ]);
  });

  it('offers the details of the stats as a button', () => {
    registerHandlers()['commandvault.stats']();

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'CommandVault Stats: 2 entries, 1 favorites',
      'Show Details',
    );
    expectShownNotificationsInert();
  });

  it('keeps the fixed warnings as they were', async () => {
    const handlers = registerHandlers();

    await handlers['commandvault.openDetail'](undefined);
    handlers['commandvault.toggleFavorite']({});
    await handlers['commandvault.copyCommand']({ entry: undefined });
    await handlers['commandvault.openFile']({ filePath: '' });

    expect(shownNotifications()).toEqual([
      'CommandVault: No entry selected',
      'CommandVault: No entry selected',
      'CommandVault: No entry selected',
      'CommandVault: No file path available',
    ]);
  });
});
