import * as vscode from 'vscode';
import type { Vault, VaultEntry, EntryType } from '@commandvault/core';

const TYPE_ICONS: Readonly<Record<EntryType, vscode.ThemeIcon>> = {
  skill: new vscode.ThemeIcon('symbol-event'),
  agent: new vscode.ThemeIcon('person'),
  command: new vscode.ThemeIcon('terminal'),
  plugin: new vscode.ThemeIcon('extensions'),
  rule: new vscode.ThemeIcon('law'),
  hook: new vscode.ThemeIcon('zap'),
};

export class FavoritesProvider implements vscode.TreeDataProvider<VaultEntry> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    VaultEntry | undefined | null
  >();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly vault: Vault) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(entry: VaultEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = TYPE_ICONS[entry.type];
    item.description = `${entry.type} - ${entry.source}`;
    item.tooltip = this.buildTooltip(entry);
    item.contextValue = 'entry';
    item.command = {
      command: 'commandvault.openDetail',
      title: 'View Detail',
      arguments: [entry],
    };
    return item;
  }

  getChildren(): VaultEntry[] {
    const allEntries = this.vault.getAllEntries();
    return allEntries
      .filter((entry) => entry.favorite)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private buildTooltip(entry: VaultEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.name}** $(star-full)\n\n`);
    md.appendMarkdown(`${entry.description}\n\n`);
    md.appendMarkdown(`**Type:** ${entry.type}  \n`);
    md.appendMarkdown(`**Source:** ${entry.source}  \n`);
    if (entry.tags.length > 0) {
      md.appendMarkdown(`**Tags:** ${entry.tags.join(', ')}`);
    }
    return md;
  }
}
