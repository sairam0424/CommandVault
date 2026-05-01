import * as vscode from 'vscode';
import { createVault, Vault } from '@commandvault/core';
import type { VaultConfig, SearchTier } from '@commandvault/core';
import { EntriesProvider } from './providers/entries-provider';
import { FavoritesProvider } from './providers/favorites-provider';
import { RecentProvider } from './providers/recent-provider';
import { registerCommands } from './commands/index';

let vault: Vault | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('commandvault');
  const claudeConfigPath = config.get<string>('claudeConfigPath') || '';
  const enableWatcher = config.get<boolean>('enableFileWatcher', true);
  const searchTier = config.get<SearchTier>('searchTier', 'minisearch');

  const vaultConfig: Partial<VaultConfig> = {
    enableWatcher,
    defaultSearchTier: searchTier,
    ...(claudeConfigPath ? { claudeConfigPath } : {}),
  };

  vault = createVault(vaultConfig);

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

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'commandvault.search';
  statusBar.tooltip = 'CommandVault — Click to search';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const refreshAll = (): void => {
    entriesProvider.refresh();
    favoritesProvider.refresh();
    recentProvider.refresh();
  };

  vault.on('scan:complete', (stats) => {
    refreshAll();
    statusBar.text = `$(database) ${stats.totalEntries} cmds`;
  });

  vault.on('entry:added', () => {
    refreshAll();
  });

  vault.on('entry:updated', () => {
    refreshAll();
  });

  vault.on('entry:removed', () => {
    refreshAll();
  });

  vault.on('error', (error) => {
    vscode.window.showWarningMessage(`CommandVault: ${error.message} (${error.filePath})`);
  });

  const commandDisposables = registerCommands(
    context,
    vault,
    entriesProvider,
    favoritesProvider,
    recentProvider,
  );

  context.subscriptions.push(...commandDisposables);

  try {
    const stats = await vault.initialize();
    vscode.window.showInformationMessage(`CommandVault: Loaded ${stats.totalEntries} entries`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`CommandVault: Failed to initialize vault - ${message}`);
  }

  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('commandvault')) {
      vscode.window.showInformationMessage(
        'CommandVault: Configuration changed. Reload window to apply.',
      );
    }
  });

  context.subscriptions.push(configWatcher);
}

export async function deactivate(): Promise<void> {
  if (vault) {
    await vault.dispose();
    vault = undefined;
  }
}
