import * as vscode from 'vscode';
import type { Vault, EntryType } from '@commandvault/core';

const TYPE_COMPLETION_KINDS: Readonly<Record<EntryType, vscode.CompletionItemKind>> = {
  skill: vscode.CompletionItemKind.Event,
  agent: vscode.CompletionItemKind.User,
  command: vscode.CompletionItemKind.Function,
  plugin: vscode.CompletionItemKind.Module,
  rule: vscode.CompletionItemKind.Reference,
  hook: vscode.CompletionItemKind.Interface,
};

export interface VaultRef {
  current: Vault | undefined;
}

export class CompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly vaultRef: VaultRef) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] | undefined {
    const vault = this.vaultRef.current;
    if (!vault) {
      return undefined;
    }

    const lineText = document.lineAt(position).text;
    const textBefore = lineText.slice(0, position.character);

    const slashMatch = textBefore.match(/\/([^\s]*)$/);
    if (!slashMatch) {
      return undefined;
    }

    const prefix = slashMatch[1];
    const slashPosition = position.character - prefix.length - 1;
    const replaceRange = new vscode.Range(
      position.line,
      slashPosition,
      position.line,
      position.character,
    );

    const entries = prefix
      ? vault.search({ query: prefix, limit: 50 }).map((r) => r.entry)
      : vault.getAllEntries().slice(0, 50);

    return entries.map((entry) => {
      const item = new vscode.CompletionItem(`/${entry.name}`, TYPE_COMPLETION_KINDS[entry.type]);
      item.detail = `${entry.type} — ${entry.source}`;
      item.documentation = entry.description;
      item.insertText = `/${entry.name}`;
      item.range = replaceRange;
      item.filterText = `/${entry.name}`;
      item.sortText = entry.name;
      return item;
    });
  }
}
