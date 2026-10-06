import * as vscode from 'vscode';
import type { Vault, VaultEntry, EntryType, SearchResult } from '@commandvault/core';
import type { EntriesProvider } from '../providers/entries-provider';
import type { FavoritesProvider } from '../providers/favorites-provider';
import type { RecentProvider } from '../providers/recent-provider';
import { createDetailPanel } from '../webview/detail-panel';
import { failureMessage } from '../webview/failure-message';
import {
  notifyError,
  notifyInfo,
  notifyWarn,
  safeNotificationText,
} from '../webview/notifications';

const COULD_NOT_OPEN_FILE = 'Could not open file';

/**
 * A control character (Unicode category Cc): the C0 controls (newline, carriage return, escape,
 * NUL, Ctrl-C ...), DEL and the C1 controls, and with them the Unicode line and paragraph
 * separators. A terminal reads a newline as Enter and an escape sequence as keystrokes, so text
 * with one is not text to type for the user: an entry name that holds `\nrm -rf ~` would run the
 * next command.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const NOT_INSERTED_MESSAGE =
  'CommandVault: Not inserted into the terminal - the text has a control character';

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
    quickPick.placeholder = 'Search commands, skills, agents...';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const updateResults = (query: string): void => {
      quickPick.busy = true;

      if (!query.trim()) {
        const allEntries = vault.getAllEntries();
        quickPick.items = allEntries.slice(0, 50).map((entry) => createQuickPickItem(entry));
        quickPick.busy = false;
        return;
      }

      const results: readonly SearchResult[] = vault.search({
        query,
        limit: 50,
      });

      if (results.length === 0) {
        quickPick.items = [
          {
            label: '$(info) No results found',
            description: `No matches for "${query}"`,
            entry: undefined as unknown as VaultEntry,
            alwaysShow: true,
          },
        ];
      } else {
        quickPick.items = results.map((result) => createQuickPickItem(result.entry, result.score));
      }

      quickPick.busy = false;
    };

    quickPick.onDidChangeValue((value) => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      quickPick.busy = true;
      debounceTimer = setTimeout(() => {
        updateResults(value);
      }, 150);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected?.entry) {
        vault.recordUsage(selected.entry.id);
        recentProvider.refresh();
        vscode.commands.executeCommand('commandvault.openDetail', selected.entry);
      }
      quickPick.dispose();
    });

    quickPick.onDidHide(() => {
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
      notifyInfo('CommandVault: Vault refreshed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifyError(`CommandVault: Refresh failed - ${safeNotificationText(message)}`);
    }
  });

  const openDetailCommand = vscode.commands.registerCommand(
    'commandvault.openDetail',
    (entry: VaultEntry) => {
      if (!entry) {
        notifyWarn('CommandVault: No entry selected');
        return;
      }
      vault.recordUsage(entry.id);
      recentProvider.refresh();
      createDetailPanel(context, entry);
    },
  );

  const toggleFavoriteCommand = vscode.commands.registerCommand(
    'commandvault.toggleFavorite',
    (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry?.id) {
        notifyWarn('CommandVault: No entry selected');
        return;
      }

      const isFavorite = vault.toggleFavorite(entry.id);
      const action = isFavorite ? 'added to' : 'removed from';
      notifyInfo(`CommandVault: "${safeNotificationText(entry.name)}" ${action} favorites`);
      refreshAll();
    },
  );

  const copyCommandCmd = vscode.commands.registerCommand(
    'commandvault.copyCommand',
    async (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry) {
        notifyWarn('CommandVault: No entry selected');
        return;
      }

      const slashCommand = vault.getSlashCommand(entry);
      await vscode.env.clipboard.writeText(slashCommand);
      notifyInfo(`CommandVault: Copied "${safeNotificationText(slashCommand)}" to clipboard`);
    },
  );

  const insertToTerminalCommand = vscode.commands.registerCommand(
    'commandvault.insertToTerminal',
    (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry) {
        notifyWarn('CommandVault: No entry selected');
        return;
      }

      const slashCommand = vault.getSlashCommand(entry);
      if (CONTROL_CHARACTER.test(slashCommand)) {
        notifyWarn(NOT_INSERTED_MESSAGE);
        return;
      }

      const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('CommandVault');
      terminal.show();
      // Typed, never run: no newline of our own, so the user reads the line and presses Enter.
      terminal.sendText(slashCommand, false);
      notifyInfo(`CommandVault: Inserted "${safeNotificationText(slashCommand)}" into terminal`);
    },
  );

  const openFileCommand = vscode.commands.registerCommand(
    'commandvault.openFile',
    async (entryOrNode: VaultEntry | { readonly entry: VaultEntry }) => {
      const entry = 'entry' in entryOrNode ? entryOrNode.entry : entryOrNode;
      if (!entry?.filePath) {
        notifyWarn('CommandVault: No file path available');
        return;
      }

      try {
        const uri = vscode.Uri.file(entry.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        notifyError(failureMessage(COULD_NOT_OPEN_FILE, err));
      }
    },
  );

  const statsCommand = vscode.commands.registerCommand('commandvault.stats', () => {
    const stats = vault.getStats();
    const typeLines = Object.entries(stats.byType)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `  ${type}: ${count}`)
      .join('\n');

    const sourceLines = Object.entries(stats.bySource)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => `  ${source}: ${count}`)
      .join('\n');

    const summary = [
      `Total Entries: ${stats.totalEntries}`,
      `Favorites: ${stats.favoriteCount}`,
      `Last Scan: ${stats.lastScanAt.toLocaleString()}`,
      '',
      'By Type:',
      typeLines,
      '',
      'By Source:',
      sourceLines,
    ].join('\n');

    notifyInfo(
      `CommandVault Stats: ${stats.totalEntries} entries, ${stats.favoriteCount} favorites`,
      'Show Details',
    ).then((selection) => {
      if (selection === 'Show Details') {
        const outputChannel = vscode.window.createOutputChannel('CommandVault Stats');
        outputChannel.clear();
        outputChannel.appendLine('=== CommandVault Stats ===');
        outputChannel.appendLine(summary);
        outputChannel.show();
      }
    });
  });

  const exportCommand = vscode.commands.registerCommand('commandvault.export', async () => {
    const allEntries = vault.getAllEntries();
    if (allEntries.length === 0) {
      notifyWarn('CommandVault: No entries to export');
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

    const exportData = {
      exportedAt: new Date().toISOString(),
      stats: vault.getStats(),
      entries: allEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        source: entry.source,
        description: entry.description,
        filePath: entry.filePath,
        tags: [...entry.tags],
        metadata: { ...entry.metadata },
        slashCommand: vault.getSlashCommand(entry),
        favorite: entry.favorite,
        usageCount: entry.usageCount,
        lastModified: entry.lastModified.toISOString(),
      })),
    };

    const content = JSON.stringify(exportData, null, 2);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(saveUri, encoder.encode(content));
    notifyInfo(
      `CommandVault: Exported ${allEntries.length} entries to ${safeNotificationText(saveUri.fsPath)}`,
    );
  });

  return [
    searchCommand,
    refreshCommand,
    openDetailCommand,
    toggleFavoriteCommand,
    copyCommandCmd,
    insertToTerminalCommand,
    openFileCommand,
    statsCommand,
    exportCommand,
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
