import * as vscode from 'vscode';
import type { Vault } from '@commandvault/core';
import type { VaultRef } from './completion-provider';

const SLASH_COMMAND_PATTERN = /\/[\w-]+/g;

export class LinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly vaultRef: VaultRef) {}

  provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.DocumentLink[] {
    const vault = this.vaultRef.current;
    if (!vault) {
      return [];
    }

    const allEntries = vault.getAllEntries();
    const entryByName = new Map(allEntries.map((e) => [e.name, e]));
    const links: vscode.DocumentLink[] = [];

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const lineText = document.lineAt(lineIndex).text;
      let match: RegExpExecArray | null;

      SLASH_COMMAND_PATTERN.lastIndex = 0;
      while ((match = SLASH_COMMAND_PATTERN.exec(lineText)) !== null) {
        const commandName = match[0].slice(1);
        const entry = entryByName.get(commandName);
        if (!entry) {
          continue;
        }

        const range = new vscode.Range(
          lineIndex,
          match.index,
          lineIndex,
          match.index + match[0].length,
        );

        const args = encodeURIComponent(JSON.stringify(entry));
        const commandUri = vscode.Uri.parse(`command:commandvault.openFile?${args}`);

        const link = new vscode.DocumentLink(range, commandUri);
        link.tooltip = `Open ${entry.name} source file`;
        links.push(link);
      }
    }

    return links;
  }
}
