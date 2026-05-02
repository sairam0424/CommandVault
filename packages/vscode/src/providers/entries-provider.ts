import * as vscode from 'vscode';
import type { Vault, VaultEntry, EntryType, EntrySource } from '@commandvault/core';

const TYPE_ICONS: Readonly<Record<EntryType, vscode.ThemeIcon>> = {
  skill: new vscode.ThemeIcon('symbol-event'),
  agent: new vscode.ThemeIcon('person'),
  command: new vscode.ThemeIcon('terminal'),
  plugin: new vscode.ThemeIcon('extensions'),
  rule: new vscode.ThemeIcon('law'),
  hook: new vscode.ThemeIcon('zap'),
};

const TYPE_LABELS: Readonly<Record<EntryType, string>> = {
  skill: 'Skills',
  agent: 'Agents',
  command: 'Commands',
  plugin: 'Plugins',
  rule: 'Rules',
  hook: 'Hooks',
};

const ALL_TYPES: readonly EntryType[] = [
  'skill',
  'agent',
  'command',
  'plugin',
  'rule',
  'hook',
] as const;

interface TypeGroupNode {
  readonly kind: 'type';
  readonly type: EntryType;
  readonly count: number;
}

interface SourceGroupNode {
  readonly kind: 'source';
  readonly type: EntryType;
  readonly source: EntrySource;
  readonly count: number;
}

interface EntryLeafNode {
  readonly kind: 'entry';
  readonly entry: VaultEntry;
}

type TreeNode = TypeGroupNode | SourceGroupNode | EntryLeafNode;

export type SortMode = 'name' | 'usage' | 'recent';

export class EntriesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    TreeNode | undefined | null
  >();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private sortBy: SortMode = 'name';
  private filterText = '';

  constructor(private readonly vault: Vault) {}

  setSortMode(mode: SortMode): void {
    this.sortBy = mode;
    this.refresh();
  }

  setFilter(text: string): void {
    this.filterText = text.toLowerCase();
    this.refresh();
  }

  getSortMode(): SortMode {
    return this.sortBy;
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'type':
        return this.createTypeItem(element);
      case 'source':
        return this.createSourceItem(element);
      case 'entry':
        return this.createEntryItem(element);
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.getRootNodes();
    }

    if (element.kind === 'type') {
      return this.getSourceNodes(element.type);
    }

    if (element.kind === 'source') {
      return this.getEntryNodes(element.type, element.source);
    }

    return [];
  }

  private getRootNodes(): TypeGroupNode[] {
    let entries = [...this.vault.getAllEntries()];

    if (this.filterText) {
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(this.filterText) ||
          e.description.toLowerCase().includes(this.filterText),
      );
    }

    const countByType = new Map<EntryType, number>();

    for (const entry of entries) {
      const current = countByType.get(entry.type) ?? 0;
      countByType.set(entry.type, current + 1);
    }

    return ALL_TYPES.filter((type) => (countByType.get(type) ?? 0) > 0).map((type) => ({
      kind: 'type' as const,
      type,
      count: countByType.get(type) ?? 0,
    }));
  }

  private getSourceNodes(type: EntryType): SourceGroupNode[] {
    const entries = this.vault.getEntriesByType(type);
    const countBySource = new Map<EntrySource, number>();

    for (const entry of entries) {
      const current = countBySource.get(entry.source) ?? 0;
      countBySource.set(entry.source, current + 1);
    }

    return Array.from(countBySource.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, count]) => ({
        kind: 'source' as const,
        type,
        source,
        count,
      }));
  }

  private getEntryNodes(type: EntryType, source: EntrySource): EntryLeafNode[] {
    let entries = [...this.vault.getEntriesByType(type)].filter((entry) => entry.source === source);

    if (this.filterText) {
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(this.filterText) ||
          e.description.toLowerCase().includes(this.filterText),
      );
    }

    switch (this.sortBy) {
      case 'usage':
        entries.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
        break;
      case 'recent':
        entries.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
        break;
      default:
        entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    return entries.map((entry) => ({ kind: 'entry' as const, entry }));
  }

  private createTypeItem(node: TypeGroupNode): vscode.TreeItem {
    const label = `${TYPE_LABELS[node.type]} (${node.count})`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = TYPE_ICONS[node.type];
    item.tooltip = `${node.count} ${TYPE_LABELS[node.type].toLowerCase()} found`;
    return item;
  }

  private createSourceItem(node: SourceGroupNode): vscode.TreeItem {
    const label = `${node.source} (${node.count})`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('folder');
    item.tooltip = `${node.count} entries from ${node.source}`;
    return item;
  }

  private createEntryItem(node: EntryLeafNode): vscode.TreeItem {
    const { entry } = node;
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = TYPE_ICONS[entry.type];
    item.description =
      entry.description.length > 60 ? `${entry.description.slice(0, 57)}...` : entry.description;
    item.tooltip = this.buildTooltip(entry);
    item.contextValue = entry.favorite ? 'entry-favorited' : 'entry';
    item.command = {
      command: 'commandvault.openDetail',
      title: 'View Detail',
      arguments: [entry],
    };
    return item;
  }

  private buildTooltip(entry: VaultEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.name}**\n\n`);
    md.appendMarkdown(`${entry.description}\n\n`);
    md.appendMarkdown(`**Type:** ${entry.type}  \n`);
    md.appendMarkdown(`**Source:** ${entry.source}  \n`);
    if (entry.tags.length > 0) {
      md.appendMarkdown(`**Tags:** ${entry.tags.join(', ')}  \n`);
    }
    md.appendMarkdown(`**File:** ${entry.filePath}  \n`);
    if (entry.favorite) {
      md.appendMarkdown(`\n$(star-full) **Favorite**`);
    }
    return md;
  }
}
