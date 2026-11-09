import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { window } from 'vscode';
import { HOSTILE_NOTIFICATION_TEXTS } from './helpers/hostile-text';
import { expectShownNotificationsInert, shownNotifications } from './helpers/notification-links';

/**
 * VS Code 1.138 draws `[label](command:...)` in a notification as a button that runs the command.
 * A scan error names a file a plugin or a cloned repository chose, and its message quotes that
 * file's content, so the toast `activate()` shows for it (and for a failed start) must carry none
 * of that as link syntax. Only the `error` event and the start-up path are exercised here; the
 * command handlers have their own suite.
 */

const mocks = vi.hoisted(() => ({ createVault: vi.fn() }));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, Record<string, unknown>>>();
  const disposable = { dispose: vi.fn() };
  return {
    ...actual,
    window: {
      ...actual.window,
      createTreeView: vi.fn().mockReturnValue({ ...disposable, badge: undefined }),
    },
    workspace: {
      ...actual.workspace,
      workspaceFolders: undefined,
      getConfiguration: vi
        .fn()
        .mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback }),
      onDidChangeConfiguration: vi.fn().mockReturnValue(disposable),
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

const STARTS = (): Promise<unknown> => Promise.resolve({ totalEntries: 3 });

type Listener = (payload: unknown) => void;

interface StartedVault {
  readonly emit: (event: string, payload: unknown) => void;
}

/** Starts the extension against a vault whose `initialize` does `initialize`; toasts shown on the way stay. */
async function activateWith(initialize: () => Promise<unknown>): Promise<StartedVault> {
  const listeners = new Map<string, readonly Listener[]>();
  mocks.createVault.mockReturnValue({
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    initialize,
    getStats: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  });
  await activate({ subscriptions: [] } as unknown as ExtensionContext);
  return { emit: (event, payload) => (listeners.get(event) ?? []).forEach((l) => l(payload)) };
}

/** Starts the extension and forgets the toasts of starting, so a test sees only what it provokes. */
async function startExtension(): Promise<StartedVault> {
  const started = await activateWith(STARTS);
  vi.clearAllMocks();
  return started;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await deactivate();
});

describe('extension: a scan error toast carries no link syntax from the file', () => {
  const PLAIN_FILE = '/home/user/.claude/commands/review.md';

  it.each(Object.entries(HOSTILE_NOTIFICATION_TEXTS))(
    '%s in the error message',
    async (_n, text) => {
      const started = await startExtension();

      started.emit('error', { message: text, filePath: PLAIN_FILE });

      expectShownNotificationsInert();
    },
  );

  it.each(Object.entries(HOSTILE_NOTIFICATION_TEXTS))('%s as the file name', async (_n, text) => {
    const started = await startExtension();

    started.emit('error', { message: 'Invalid frontmatter', filePath: `/home/user/${text}.md` });

    expectShownNotificationsInert();
  });

  it.each(Object.entries(HOSTILE_NOTIFICATION_TEXTS))('%s as both at once', async (_n, text) => {
    const started = await startExtension();

    started.emit('error', { message: `cannot read ${text}`, filePath: text });

    expectShownNotificationsInert();
  });

  it('names the file, not the directory it is in, and keeps a benign message readable', async () => {
    const started = await startExtension();

    started.emit('error', { message: 'Invalid frontmatter', filePath: PLAIN_FILE });

    expect(shownNotifications()).toEqual(['CommandVault: Invalid frontmatter (review.md)']);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('shows a file name and a message with parentheses and backslashes as they are', async () => {
    const started = await startExtension();

    started.emit('error', {
      message: 'Invalid frontmatter in C:\\Users\\me\\review.md',
      filePath: '/home/user/.claude/commands/review (copy).md',
    });

    expect(shownNotifications()).toEqual([
      'CommandVault: Invalid frontmatter in C:\\Users\\me\\review.md (review (copy).md)',
    ]);
  });

  it('does not repeat a hostile directory name', async () => {
    const started = await startExtension();
    const directory = HOSTILE_NOTIFICATION_TEXTS.commandLink;

    started.emit('error', { message: 'Invalid frontmatter', filePath: `/work/${directory}/a.md` });

    expect(shownNotifications()).toEqual(['CommandVault: Invalid frontmatter (a.md)']);
  });

  it('shows no parentheses when the error has no file (a failed re-scan)', async () => {
    const started = await startExtension();

    started.emit('error', { filePath: '', message: 'Re-scan failed: Error: boom' });

    expect(shownNotifications()).toEqual(['CommandVault: Re-scan failed: Error: boom']);
  });

  it.each([
    ['no message and no path', {}],
    ['a message that is not text', { message: { toString: () => 'x' }, filePath: 42 }],
    ['null fields', { message: null, filePath: null }],
  ])('still shows a toast, and does not throw, for %s', async (_label, error) => {
    const started = await startExtension();

    expect(() => started.emit('error', error)).not.toThrow();

    expectShownNotificationsInert();
  });
});

describe('extension: start-up toasts carry no link syntax', () => {
  const failsWith = (reason: unknown) => (): Promise<unknown> => Promise.reject(reason);

  it.each(Object.entries(HOSTILE_NOTIFICATION_TEXTS))(
    '%s in the reason the vault failed to start',
    async (_n, text) => {
      await activateWith(failsWith(new Error(`cannot open ${text}`)));

      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expectShownNotificationsInert();
    },
  );

  it('copes with a start-up failure that is not an Error', async () => {
    await activateWith(failsWith(HOSTILE_NOTIFICATION_TEXTS.commandLink));

    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expectShownNotificationsInert();
  });

  it('says how many entries loaded', async () => {
    await activateWith(STARTS);

    expect(shownNotifications()).toEqual(['CommandVault: Loaded 3 entries']);
  });

  it('says why it failed to start', async () => {
    await activateWith(failsWith(new Error('database is locked')));

    expect(shownNotifications()).toEqual([
      'CommandVault: Failed to initialize vault - database is locked',
    ]);
  });
});
