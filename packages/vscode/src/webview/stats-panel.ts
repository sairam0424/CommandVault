import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Vault } from '@commandvault/core';

const PANEL_VIEW_TYPE = 'commandvault.stats';
const PANEL_TITLE = 'CommandVault Stats';

let activePanel: vscode.WebviewPanel | undefined;

export function createStatsPanel(
  context: vscode.ExtensionContext,
  vault: Vault
): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.One);
    sendStats(activePanel, vault);
    return activePanel;
  }

  const panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    PANEL_TITLE,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview')),
      ],
    }
  );

  const distPath = path.join(context.extensionPath, 'dist', 'webview');
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(distPath, 'main.js'))
  );

  const nonce = crypto.randomBytes(16).toString('hex');

  panel.webview.html = buildHtml(panel.webview, scriptUri, nonce);

  panel.webview.onDidReceiveMessage(
    (message: { type: string }) => {
      if (message.type === 'ready') {
        sendStats(panel, vault);
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(
    () => {
      activePanel = undefined;
    },
    null,
    context.subscriptions
  );

  activePanel = panel;

  return panel;
}

function sendStats(panel: vscode.WebviewPanel, vault: Vault): void {
  const stats = vault.getStats();
  const serializedStats = {
    ...stats,
    lastScanAt: stats.lastScanAt.toISOString(),
  };
  panel.webview.postMessage({ type: 'stats', data: serializedStats });

  const allEntries = vault.getAllEntries();
  const topUsed = [...allEntries]
    .filter((entry) => entry.usageCount > 0)
    .sort((a, b) => b.usageCount - a.usageCount)
    .slice(0, 10)
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      usageCount: entry.usageCount,
    }));
  panel.webview.postMessage({ type: 'topUsed', data: topUsed });
}

function buildHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  nonce: string
): string {
  const cspSource = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${PANEL_TITLE}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
