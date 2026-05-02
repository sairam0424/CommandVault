import * as vscode from 'vscode';
import type { Vault, VaultEntry, EntryType, SearchResult } from '@commandvault/core';
import { exportEntries, importFromFile } from '@commandvault/core';
import type { EntriesProvider } from '../providers/entries-provider';
import type { FavoritesProvider } from '../providers/favorites-provider';
import type { RecentProvider } from '../providers/recent-provider';
import { createDetailPanel } from '../webview/detail-panel';
import { createStatsPanel } from '../webview/stats-panel';

const TYPE_ICONS: Readonly<Record<EntryType, string>> = {
  skill: '$(symbol-event)',
  agent: '$(person)',
  command: '$(terminal)',
  plugin: '$(extensions)',
  rule: '$(law)',
  hook: '$(zap)',
};

interface SearchQuickPickItem extends vscode.QuickPickItem {
  readonly entry: VaultEntry;
}

function parseSearchInput(input: string): {
  query: string;
  type?: EntryType;
  tags?: string[];
} {
  let query = input;
  let type: EntryType | undefined;
  const tags: string[] = [];

  const typeMatch = query.match(/^type:(\w+)\s*/);
  if (typeMatch) {
    type = typeMatch[1] as EntryType;
    query = query.slice(typeMatch[0].length);
  }

  let tagMatch: RegExpMatchArray | null;
  while ((tagMatch = query.match(/^tag:(\w+)\s*/))) {
    tags.push(tagMatch[1]);
    query = query.slice(tagMatch[0].length);
  }

  return { query, type, tags: tags.length > 0 ? tags : undefined };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  vault: Vault,
  entriesProvider: EntriesProvider,
  favoritesProvider: FavoritesProvider,
  recentProvider: RecentProvider,
): readonly vscode.Disposable[] {
  const refreshAll = (): void => {
    entriesProvider.refresh();
    favoritesProvider.refresh();
    recentProvider.refresh();
  };

  const searchCommand = vscode.commands.registerCommand('commandvault.search', async () => {
    const quickPick = vscode.window.createQuickPick<SearchQuickPickItem>();
    quickPick.placeholder = 'Search commands (try type:skill or tag:security)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let isDisposed = false;

    const updateResults = (input: string): void => {
      if (isDisposed) return;

      const { query, type, tags } = parseSearchInput(input);

      if (!query.trim() && !type && !tags) {
        const allEntries = vault.getAllEntries();
        quickPick.items = allEntries.slice(0, 50).map((entry) => createQuickPickItem(entry));
        return;
      }

      if (!query.trim() && (type || tags)) {
        const allEntries = vault.getAllEntries().filter((entry) => {
          if (type && entry.type !== type) return false;
          if (tags && !tags.every((t) => entry.tags.includes(t))) return false;
          return true;
        });
        quickPick.items = allEntries.slice(0, 50).map((entry) => createQuickPickItem(entry));
        return;
      }

      const results: readonly SearchResult[] = vault.search({
        query,
        type,
        tags,
        limit: 50,
      });

      quickPick.items = results.map((result) => createQuickPickItem(result.entry, result.score));
    };

    quickPick.onDidChangeValue((value) => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        updateResults(value);
      }, 150);
    });

    quickPick.onDidAccept(() => {
      isDisposed = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      const selected = quickPick.selectedItems[0];
      if (selected) {
        vault.recordUsage(selected.entry.id);
        recentProvider.refresh();
        vscode.commands.executeCommand('commandvault.openDetail', selected.entry);
      }
      quickPick.dispose();
    });

    quickPick.onDidHide(() => {
      isDisposed = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      quickPick.dispose();
    });

    updateResults('');
    quickPick.show();
  });

  const refreshCommand = vscode.commands.registerCommand('commandvault.refresh', async () => {
    try {
      await vault.scan();
      vscode.window.showInformationMessage('CommandVault: Vault refreshed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`CommandVault: Refresh failed - ${message}`);
    }
  });

  const openDetailCommand = vscode.commands.registerCommand(
    'commandvault.openDetail',
    (entry: VaultEntry) => {
      if (!entry) {
        vscode.window.showWarningMessage('CommandVault: No entry selected');
        return;
      }
      vault.recordUsage(entry.id);
      recentProvider.refresh();
      createDetailPanel(context, entry);
    },
  );

  const toggleFavoriteHandler = (
    entryOrNode: VaultEntry | { readonly entry: VaultEntry },
  ): void => {
    const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
    if (!entry?.id) {
      vscode.window.showWarningMessage('CommandVault: No entry selected');
      return;
    }

    const isFavorite = vault.toggleFavorite(entry.id);
    const action = isFavorite ? 'added to' : 'removed from';
    vscode.window.showInformationMessage(`CommandVault: "${entry.name}" ${action} favorites`);
    refreshAll();
  };

  const toggleFavoriteCommand = vscode.commands.registerCommand(
    'commandvault.toggleFavorite',
    toggleFavoriteHandler,
  );

  const unfavoriteCommand = vscode.commands.registerCommand(
    'commandvault.unfavorite',
    toggleFavoriteHandler,
  );

  const copyCommandCmd = vscode.commands.registerCommand(
    'commandvault.copyCommand',
    async (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry) {
        vscode.window.showWarningMessage('CommandVault: No entry selected');
        return;
      }

      const slashCommand = vault.getSlashCommand(entry);
      await vscode.env.clipboard.writeText(slashCommand);
      vscode.window.showInformationMessage(`CommandVault: Copied "${slashCommand}" to clipboard`);
    },
  );

  const insertToTerminalCommand = vscode.commands.registerCommand(
    'commandvault.insertToTerminal',
    (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry) {
        vscode.window.showWarningMessage('CommandVault: No entry selected');
        return;
      }

      const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('CommandVault');
      terminal.show();
      const slashCommand = vault.getSlashCommand(entry);
      terminal.sendText(slashCommand, false);
      vscode.window.showInformationMessage(
        `CommandVault: Inserted "${slashCommand}" into terminal`,
      );
    },
  );

  const openFileCommand = vscode.commands.registerCommand(
    'commandvault.openFile',
    async (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry?.filePath) {
        vscode.window.showWarningMessage('CommandVault: No file path available');
        return;
      }

      try {
        const uri = vscode.Uri.file(entry.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`CommandVault: Could not open file - ${message}`);
      }
    },
  );

  const statsCommand = vscode.commands.registerCommand('commandvault.stats', () => {
    createStatsPanel(context, vault);
  });

  const exportCommand = vscode.commands.registerCommand('commandvault.export', async () => {
    const allEntries = vault.getAllEntries();
    if (allEntries.length === 0) {
      vscode.window.showWarningMessage('CommandVault: No entries to export');
      return;
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('commandvault-export.json'),
      filters: { JSON: ['json'] },
      title: 'Export CommandVault Collection',
    });

    if (!saveUri) {
      return;
    }

    const bundle = exportEntries(allEntries, 'commandvault-ai');
    const content = JSON.stringify(bundle, null, 2);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(saveUri, encoder.encode(content));
    vscode.window.showInformationMessage(
      `CommandVault: Exported ${allEntries.length} entries to ${saveUri.fsPath}`,
    );
  });

  const copyContentCommand = vscode.commands.registerCommand(
    'commandvault.copyContent',
    async (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry) {
        vscode.window.showWarningMessage('CommandVault: No entry selected');
        return;
      }

      await vscode.env.clipboard.writeText(entry.content);
      vscode.window.showInformationMessage(
        `CommandVault: Copied content of "${entry.name}" to clipboard`,
      );
    },
  );

  const importCommand = vscode.commands.registerCommand('commandvault.import', async () => {
    const uris = await vscode.window.showOpenDialog({
      filters: { 'Vault JSON': ['json'] },
      canSelectMany: false,
      title: 'Import CommandVault Collection',
    });
    if (!uris?.[0]) return;

    try {
      const result = await importFromFile(uris[0].fsPath);

      if (result.entries.length === 0) {
        vscode.window.showWarningMessage('No valid entries found in file');
        return;
      }

      await vault.addEntries(result.entries);
      refreshAll();
      vscode.window.showInformationMessage(
        `Imported ${result.entries.length} entries (${result.errors.length} warnings)`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Import failed: ${(err as Error).message}`);
    }
  });

  return [
    searchCommand,
    refreshCommand,
    openDetailCommand,
    toggleFavoriteCommand,
    unfavoriteCommand,
    copyCommandCmd,
    copyContentCommand,
    insertToTerminalCommand,
    openFileCommand,
    statsCommand,
    exportCommand,
    importCommand,
  ];
}

function createQuickPickItem(entry: VaultEntry, score?: number): SearchQuickPickItem {
  const icon = TYPE_ICONS[entry.type];
  const scoreLabel = score !== undefined ? ` (${Math.round(score * 100)}%)` : '';
  return {
    label: `${icon} ${entry.name}`,
    description: `${entry.type} - ${entry.source}${scoreLabel}`,
    detail: entry.description,
    entry,
  };
}
