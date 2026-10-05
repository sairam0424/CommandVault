import * as vscode from 'vscode';
import type { Vault } from '@commandvault/core';
import type { VaultRef } from './completion-provider';
import { escapeMarkdownInline, fencedCodeBlock } from './markdown-text';
import { sourceFileUri } from './source-link';

const SLASH_COMMAND_PATTERN = /\/[\w-]+/g;
const PREVIEW_LINE_COUNT = 10;
const OPEN_SOURCE_FILE_LABEL = 'Open Source File';

/** What `vscode.Uri.toString()` can produce for a local file: percent-encoding leaves nothing else. */
const SAFE_FILE_URI = /^file:\/\/\/[A-Za-z0-9%._~/-]+$/;

export class HoverProvider implements vscode.HoverProvider {
  constructor(private readonly vaultRef: VaultRef) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
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

      const contentPreview = entry.content.split('\n').slice(0, PREVIEW_LINE_COUNT).join('\n');

      // Never trusted: every string here contains entry text, which third parties write, and a
      // trusted MarkdownString turns `[x](command:...)` in that text into a clickable command.
      const md = new vscode.MarkdownString();
      md.appendMarkdown(
        `**${escapeMarkdownInline(entry.name)}** (${escapeMarkdownInline(entry.type)}) — ` +
          `${escapeMarkdownInline(entry.description)}\n\n`,
      );
      md.appendMarkdown(fencedCodeBlock(contentPreview));
      const openLink = this.openSourceFileLink(entry.filePath);
      if (openLink) {
        md.appendMarkdown(`\n${openLink}`);
      }

      const range = new vscode.Range(position.line, start, position.line, end);

      return new vscode.Hover(md, range);
    }

    return undefined;
  }

  /**
   * A plain link to the file, not a command: the editor opens `file:` links itself, so no command
   * is involved and no entry data travels in the link.
   */
  private openSourceFileLink(filePath: string): string | undefined {
    const destination = sourceFileUri(filePath)?.toString();
    if (destination === undefined || !SAFE_FILE_URI.test(destination)) {
      return undefined;
    }
    return `[${OPEN_SOURCE_FILE_LABEL}](${destination})`;
  }

  private findEntryByName(vault: Vault, name: string) {
    const allEntries = vault.getAllEntries();
    return allEntries.find((e) => e.name === name);
  }
}
