import * as vscode from 'vscode';
import { createVault, Vault } from '@commandvault/core';
import type { VaultConfig, VaultStats, SearchTier } from '@commandvault/core';
import { EntriesProvider, type SortMode } from './providers/entries-provider';
import { FavoritesProvider } from './providers/favorites-provider';
import { RecentProvider } from './providers/recent-provider';
import { registerCommands } from './commands/index';

export interface VaultRef {
  current: Vault | undefined;
}

let vault: Vault | undefined;

function buildVaultConfig(): Partial<VaultConfig> {
  const config = vscode.workspace.getConfiguration('commandvault');
  const claudeConfigPath = config.get<string>('claudeConfigPath') || '';
  const enableWatcher = config.get<boolean>('enableFileWatcher', true);
  const searchTier = config.get<SearchTier>('searchTier', 'minisearch');

  return {
    enableWatcher,
    defaultSearchTier: searchTier,
    ...(claudeConfigPath ? { claudeConfigPath } : {}),
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  vault = createVault(buildVaultConfig());
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

  const updateStatusBar = (): void => {
    if (!vault) return;
    const total = vault.getAllEntries().length;
    const filter = entriesProvider.getFilter();
    if (filter) {
      const filtered = vault
        .getAllEntries()
        .filter(
          (e) =>
            e.name.toLowerCase().includes(filter) || e.description.toLowerCase().includes(filter),
        ).length;
      statusBar.text = `$(database) ${filtered}/${total} cmds`;
    } else {
      statusBar.text = `$(database) ${total} cmds`;
    }
  };

  const onScanComplete = (_stats: VaultStats): void => {
    refreshAll();
    updateStatusBar();
  };
  const onEntryChange = (): void => {
    refreshAll();
    updateStatusBar();
  };
  const onError = (error: { filePath: string; message: string }): void => {
    vscode.window.showWarningMessage(`CommandVault: ${error.message} (${error.filePath})`);
  };

  const bindVaultEvents = (v: Vault): void => {
    v.on('scan:complete', onScanComplete);
    v.on('entry:added', onEntryChange);
    v.on('entry:updated', onEntryChange);
    v.on('entry:removed', onEntryChange);
    v.on('error', onError);
  };

  const unbindVaultEvents = (v: Vault): void => {
    v.off('scan:complete', onScanComplete);
    v.off('entry:added', onEntryChange);
    v.off('entry:updated', onEntryChange);
    v.off('entry:removed', onEntryChange);
    v.off('error', onError);
  };

  bindVaultEvents(vault);

  context.subscriptions.push({
    dispose: () => {
      if (vault) unbindVaultEvents(vault);
    },
  });

  const commandDisposables = registerCommands(
    context,
    vaultRef,
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

  const filterCommand = vscode.commands.registerCommand(
    'commandvault.filterEntries',
    async (filterText?: string) => {
      if (typeof filterText === 'string') {
        entriesProvider.setFilter(filterText);
        updateStatusBar();
        return;
      }
      const text = await vscode.window.showInputBox({
        placeHolder: 'Filter entries by name or description (empty to clear)',
        prompt: 'Enter filter text',
      });
      if (text !== undefined) {
        entriesProvider.setFilter(text);
        updateStatusBar();
      }
    },
  );

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

  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (
      e.affectsConfiguration('commandvault.claudeConfigPath') ||
      e.affectsConfiguration('commandvault.searchTier')
    ) {
      try {
        if (vault) {
          unbindVaultEvents(vault);
          await vault.dispose();
        }

        vault = createVault(buildVaultConfig());
        vaultRef.current = vault;
        bindVaultEvents(vault);

        const stats = await vault.initialize();
        refreshAll();
        updateStatusBar();
        vscode.window.showInformationMessage(
          `CommandVault: Configuration reloaded (${stats.totalEntries} entries)`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`CommandVault: Reload failed — ${(err as Error).message}`);
      }
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
