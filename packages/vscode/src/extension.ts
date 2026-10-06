import { basename } from 'path';
import * as vscode from 'vscode';
import { createVault, Vault } from '@commandvault/core';
import type { VaultConfig, SearchTier } from '@commandvault/core';
import { EntriesProvider } from './providers/entries-provider';
import { FavoritesProvider } from './providers/favorites-provider';
import { RecentProvider } from './providers/recent-provider';
import { CompletionProvider } from './providers/completion-provider';
import type { VaultRef } from './providers/completion-provider';
import { HoverProvider } from './providers/hover-provider';
import { LinkProvider } from './providers/link-provider';
import { registerCommands } from './commands/index';
import { notifyError, notifyInfo, notifyWarn, safeNotificationText } from './webview/notifications';

let vault: Vault | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('commandvault');
  const claudeConfigPath = config.get<string>('claudeConfigPath') || '';
  const enableWatcher = config.get<boolean>('enableFileWatcher', true);
  const searchTier = config.get<SearchTier>('searchTier', 'minisearch');

  // The core indexes a project directory only when given one. The workspace folder is the project;
  // with no folder open there is none, and nothing is read from the extension host's directory.
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const vaultConfig: Partial<VaultConfig> = {
    enableWatcher,
    defaultSearchTier: searchTier,
    ...(claudeConfigPath ? { claudeConfigPath } : {}),
    ...(projectRoot ? { projectRoot } : {}),
  };

  vault = createVault(vaultConfig);

  const vaultRef: VaultRef = { current: vault };

  const entriesProvider = new EntriesProvider(vault);
  const favoritesProvider = new FavoritesProvider(vault);
  const recentProvider = new RecentProvider(vault);

  const entriesTreeView = vscode.window.createTreeView('commandvault.entries', {
    treeDataProvider: entriesProvider,
    showCollapseAll: true,
  });

  const favoritesTreeView = vscode.window.createTreeView('commandvault.favorites', {
    treeDataProvider: favoritesProvider,
  });

  const recentTreeView = vscode.window.createTreeView('commandvault.recent', {
    treeDataProvider: recentProvider,
  });

  context.subscriptions.push(entriesTreeView, favoritesTreeView, recentTreeView);

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const debouncedRefreshAll = (): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      entriesProvider.refresh();
      favoritesProvider.refresh();
      recentProvider.refresh();

      const stats = vault?.getStats();
      if (stats) {
        entriesTreeView.badge = {
          value: stats.totalEntries,
          tooltip: 'Total commands',
        };
      }
    }, 500);
  };

  vault.on('scan:complete', () => {
    debouncedRefreshAll();
  });

  vault.on('entry:added', () => {
    debouncedRefreshAll();
  });

  vault.on('entry:updated', () => {
    debouncedRefreshAll();
  });

  vault.on('entry:removed', () => {
    debouncedRefreshAll();
  });

  vault.on('error', (error) => {
    // The message quotes the file and the file's name is a third party's: both go through
    // safeNotificationText, and the directory (where the hostile part of a path usually is) is
    // left out.
    const fileName = safeNotificationText(fileNameOf(error.filePath));
    const where = fileName ? ` (${fileName})` : '';
    notifyWarn(`CommandVault: ${safeNotificationText(error.message)}${where}`);
  });

  const commandDisposables = registerCommands(
    context,
    vault,
    entriesProvider,
    favoritesProvider,
    recentProvider,
  );

  context.subscriptions.push(...commandDisposables);

  const documentSelector: vscode.DocumentSelector = [
    { language: 'markdown' },
    { language: 'plaintext' },
  ];

  const allLanguagesSelector: vscode.DocumentSelector = [{ pattern: '**/*' }];

  const completionDisposable = vscode.languages.registerCompletionItemProvider(
    allLanguagesSelector,
    new CompletionProvider(vaultRef),
    '/',
  );

  const hoverDisposable = vscode.languages.registerHoverProvider(
    documentSelector,
    new HoverProvider(vaultRef),
  );

  const linkDisposable = vscode.languages.registerDocumentLinkProvider(
    documentSelector,
    new LinkProvider(vaultRef),
  );

  context.subscriptions.push(completionDisposable, hoverDisposable, linkDisposable);

  try {
    const stats = await vault.initialize();
    entriesTreeView.badge = {
      value: stats.totalEntries,
      tooltip: 'Total commands',
    };
    notifyInfo(`CommandVault: Loaded ${stats.totalEntries} entries`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notifyError(`CommandVault: Failed to initialize vault - ${safeNotificationText(message)}`);
  }

  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('commandvault')) {
      notifyInfo('CommandVault: Configuration changed. Reload window to apply.');
    }
  });

  context.subscriptions.push(configWatcher);
}

/** The file a scan error is about, or '' when it is about none (a failed re-scan has `filePath: ''`). */
function fileNameOf(filePath: unknown): string {
  return typeof filePath === 'string' ? basename(filePath) : '';
}

export async function deactivate(): Promise<void> {
  if (vault) {
    await vault.dispose();
    vault = undefined;
  }
}
