import * as vscode from 'vscode';
import type { Vault } from '@commandvault/core';
import type { VaultRef } from './completion-provider';

const SLASH_COMMAND_PATTERN = /\/[\w-]+/g;

export class HoverProvider implements vscode.HoverProvider {
  constructor(private readonly vaultRef: VaultRef) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.Hover | undefined {
    const vault = this.vaultRef.current;
    if (!vault) {
      return undefined;
    }

    const lineText = document.lineAt(position).text;
    let match: RegExpExecArray | null;

    SLASH_COMMAND_PATTERN.lastIndex = 0;
    while ((match = SLASH_COMMAND_PATTERN.exec(lineText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      if (position.character < start || position.character > end) {
        continue;
      }

      const commandName = match[0].slice(1);
      const entry = this.findEntryByName(vault, commandName);
      if (!entry) {
        continue;
      }

      const contentPreview = entry.content
        .split('\n')
        .slice(0, 10)
        .join('\n');

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${entry.name}** (${entry.type}) — ${entry.description}\n\n`);
      md.appendCodeblock(contentPreview, 'text');
      md.appendMarkdown(
        `\n\n[Open Source File](command:commandvault.openFile?${encodeURIComponent(JSON.stringify(entry))})`
      );
      md.isTrusted = true;

      const range = new vscode.Range(
        position.line,
        start,
        position.line,
        end
      );

      return new vscode.Hover(md, range);
    }

    return undefined;
  }

  private findEntryByName(vault: Vault, name: string) {
    const allEntries = vault.getAllEntries();
    return allEntries.find((e) => e.name === name);
  }
}
