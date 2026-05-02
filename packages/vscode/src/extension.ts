import * as vscode from 'vscode';
import { createVault, Vault } from '@commandvault/core';
import type { VaultConfig, VaultStats, SearchTier } from '@commandvault/core';
import { EntriesProvider, type SortMode } from './providers/entries-provider';
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

  const onScanComplete = (stats: VaultStats): void => {
    refreshAll();
    statusBar.text = `$(database) ${stats.totalEntries} cmds`;
  };
  const onEntryChange = (): void => refreshAll();
  const onError = (error: { filePath: string; message: string }): void => {
    vscode.window.showWarningMessage(`CommandVault: ${error.message} (${error.filePath})`);
  };

  vault.on('scan:complete', onScanComplete);
  vault.on('entry:added', onEntryChange);
  vault.on('entry:updated', onEntryChange);
  vault.on('entry:removed', onEntryChange);
  vault.on('error', onError);

  context.subscriptions.push({
    dispose: () => {
      vault.off('scan:complete', onScanComplete);
      vault.off('entry:added', onEntryChange);
      vault.off('entry:updated', onEntryChange);
      vault.off('entry:removed', onEntryChange);
      vault.off('error', onError);
    },
  });

  const commandDisposables = registerCommands(
    context,
    vault,
    entriesProvider,
    favoritesProvider,
    recentProvider,
  );

  context.subscriptions.push(...commandDisposables);

  const sortCommand = vscode.commands.registerCommand('commandvault.sortEntries', async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(list-ordered) Alphabetical', value: 'name' as SortMode },
        { label: '$(flame) Most Used', value: 'usage' as SortMode },
        { label: '$(history) Recently Modified', value: 'recent' as SortMode },
      ],
      { placeHolder: `Sort by (current: ${entriesProvider.getSortMode()})` },
    );
    if (pick) entriesProvider.setSortMode(pick.value);
  });

  const filterCommand = vscode.commands.registerCommand('commandvault.filterEntries', async () => {
    const text = await vscode.window.showInputBox({
      placeHolder: 'Filter entries by name or description (empty to clear)',
      prompt: 'Enter filter text',
    });
    if (text !== undefined) entriesProvider.setFilter(text);
  });

  context.subscriptions.push(sortCommand, filterCommand);

  try {
    const stats = await vault.initialize();
    vscode.window.showInformationMessage(`CommandVault: Loaded ${stats.totalEntries} entries`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBar.text = '$(warning) CommandVault: Init failed';
    statusBar.tooltip = `Initialization failed: ${message}`;
    const action = await vscode.window.showErrorMessage(
      `CommandVault failed to initialize: ${message}`,
      'Retry',
      'Open Settings',
    );
    if (action === 'Retry') {
      await vscode.commands.executeCommand('commandvault.refresh');
    } else if (action === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'commandvault.claudeConfigPath',
      );
    }
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
