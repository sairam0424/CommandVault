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

const RECENT_LIMIT = 20;

export class RecentProvider implements vscode.TreeDataProvider<VaultEntry> {
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
    item.description = `${entry.type} - used ${entry.usageCount}x`;
    item.tooltip = this.buildTooltip(entry);
    item.contextValue = entry.favorite ? 'entry-favorited' : 'entry';
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
      .filter((entry) => entry.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, RECENT_LIMIT);
  }

  private buildTooltip(entry: VaultEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.name}**\n\n`);
    md.appendMarkdown(`${entry.description}\n\n`);
    md.appendMarkdown(`**Used:** ${entry.usageCount} times  \n`);
    md.appendMarkdown(`**Type:** ${entry.type}  \n`);
    md.appendMarkdown(`**Source:** ${entry.source}`);
    return md;
  }
}
