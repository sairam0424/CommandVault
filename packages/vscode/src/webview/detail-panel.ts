import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { VaultEntry } from '@commandvault/core';
import { failureMessage } from './failure-message';
import { resolveOpenableFile } from './open-file-policy';
import { toScriptJson } from './script-json';

const OUTSIDE_ALLOWED_DIRECTORIES_MESSAGE =
  'CommandVault: Cannot open file outside allowed directories';

const COULD_NOT_OPEN_FILE = 'Could not open file';

const PANEL_COLUMN = vscode.ViewColumn.One;

const activePanels = new Map<string, vscode.WebviewPanel>();

export function createDetailPanel(
  context: vscode.ExtensionContext,
  entry: VaultEntry,
): vscode.WebviewPanel {
  const existingPanel = activePanels.get(entry.id);
  if (existingPanel) {
    existingPanel.reveal(PANEL_COLUMN);
    const nonce = crypto.randomBytes(16).toString('hex');
    existingPanel.webview.html = buildHtml(entry, nonce);
    return existingPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'commandvault.detail',
    `${entry.name} - CommandVault`,
    PANEL_COLUMN,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    },
  );

  panel.iconPath = new vscode.ThemeIcon(getIconForType(entry.type));
  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = buildHtml(entry, nonce);

  panel.webview.onDidReceiveMessage(
    async (message: { type: string; text?: string; path?: unknown }) => {
      if (message.type === 'copy' && message.text) {
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage('CommandVault: Copied to clipboard');
      } else if (message.type === 'openFile' && message.path) {
        await openSourceFile(message.path);
      }
    },
    undefined,
    context.subscriptions,
  );

  activePanels.set(entry.id, panel);

  panel.onDidDispose(
    () => {
      activePanels.delete(entry.id);
    },
    null,
    context.subscriptions,
  );

  return panel;
}

async function openSourceFile(requestedPath: unknown): Promise<void> {
  try {
    const realPath = await resolveOpenableFile(requestedPath);
    if (!realPath) {
      vscode.window.showErrorMessage(OUTSIDE_ALLOWED_DIRECTORIES_MESSAGE);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(realPath));
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(failureMessage(COULD_NOT_OPEN_FILE, err));
  }
}

function getIconForType(type: VaultEntry['type']): string {
  const icons: Readonly<Record<VaultEntry['type'], string>> = {
    skill: 'symbol-event',
    agent: 'person',
    command: 'terminal',
    plugin: 'extensions',
    rule: 'law',
    hook: 'zap',
  };
  return icons[type];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderMetadataTable(metadata: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(metadata);
  if (keys.length === 0) {
    return '<p class="muted">No metadata</p>';
  }

  const rows = keys
    .sort()
    .map((key) => {
      const value = metadata[key];
      const displayValue =
        typeof value === 'object' && value !== null
          ? escapeHtml(JSON.stringify(value, null, 2))
          : escapeHtml(String(value ?? ''));
      return `<tr><td class="meta-key">${escapeHtml(key)}</td><td class="meta-value"><pre>${displayValue}</pre></td></tr>`;
    })
    .join('\n');

  return `<table class="metadata-table">${rows}</table>`;
}

function renderTags(tags: readonly string[]): string {
  if (tags.length === 0) {
    return '<span class="muted">None</span>';
  }
  return tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ');
}

function renderContent(content: string): string {
  if (!content.trim()) {
    return '<p class="muted">No content available</p>';
  }
  return `<pre class="content-block">${escapeHtml(content)}</pre>`;
}

function buildHtml(entry: VaultEntry, nonce: string): string {
  const typeBadgeClass = `badge badge-type badge-${escapeHtml(entry.type)}`;
  const sourceBadgeClass = 'badge badge-source';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      line-height: 1.6;
    }

    .header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }

    .header h1 {
      font-size: 1.6em;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 8px;
    }

    .badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .badge {
      display: inline-block;
      padding: 2px 10px;
      border: 1px solid transparent;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    /* The badge colours are a pair the theme guarantees is readable. The type is told apart by the
       border, so no text sits on a chart colour (which no theme pairs with a text colour). */
    .badge-type {
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .badge-skill { border-color: var(--vscode-charts-green); }
    .badge-agent { border-color: var(--vscode-charts-blue); }
    .badge-command { border-color: var(--vscode-charts-yellow); }
    .badge-plugin { border-color: var(--vscode-charts-purple); }
    .badge-rule { border-color: var(--vscode-charts-orange); }
    .badge-hook { border-color: var(--vscode-charts-red); }

    .badge-source {
      background-color: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-descriptionForeground);
    }

    .description {
      font-size: 1.05em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .file-path {
      font-size: 0.85em;
      color: var(--vscode-textLink-foreground);
      word-break: break-all;
    }

    .section {
      margin-bottom: 24px;
    }

    .section h2 {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-widget-border);
      padding-bottom: 4px;
    }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8em;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      margin-right: 4px;
      margin-bottom: 4px;
    }

    .metadata-table {
      width: 100%;
      border-collapse: collapse;
    }

    .metadata-table tr {
      border-bottom: 1px solid var(--vscode-widget-border);
    }

    .metadata-table td {
      padding: 6px 8px;
      vertical-align: top;
    }

    .meta-key {
      font-weight: 600;
      white-space: nowrap;
      width: 1%;
      color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground));
    }

    .meta-value pre {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
    }

    .content-block {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      background-color: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 16px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      max-height: 600px;
      overflow-y: auto;
    }

    .muted {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .info-row {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
      margin-top: 8px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }

    .info-row span {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    /* The primary button pair: the only button colours every built-in theme defines together. */
    .copy-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 8px;
      margin-left: 8px;
      font-size: 0.75em;
      font-weight: 500;
      color: var(--vscode-button-foreground);
      background-color: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      cursor: pointer;
      vertical-align: middle;
      line-height: 1.4;
    }

    .copy-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .file-link {
      font-size: 0.85em;
      color: var(--vscode-textLink-foreground);
      word-break: break-all;
      cursor: pointer;
      text-decoration: underline;
    }

    .file-link:hover {
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    }

    .section-header {
      display: flex;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>
      ${escapeHtml(entry.name)}
      <button class="copy-btn" data-copy="${escapeHtml(entry.name)}" title="Copy name">Copy</button>
    </h1>
    <div class="badges">
      <span class="${typeBadgeClass}">${escapeHtml(entry.type)}</span>
      <span class="${sourceBadgeClass}">${escapeHtml(entry.source)}</span>
      ${entry.favorite ? '<span class="badge badge-type">&#9733; Favorite</span>' : ''}
    </div>
    <p class="description">${escapeHtml(entry.description)}</p>
    <a class="file-link" data-path="${escapeHtml(entry.filePath)}" title="Open file in editor">${escapeHtml(entry.filePath)}</a>
    <div class="info-row">
      <span>Used: ${escapeHtml(String(entry.usageCount))} times</span>
      <span>Modified: ${entry.lastModified.toLocaleDateString()}</span>
    </div>
  </div>

  <div class="section">
    <h2>Tags</h2>
    ${renderTags(entry.tags)}
  </div>

  <div class="section">
    <h2>Metadata</h2>
    ${renderMetadataTable(entry.metadata)}
  </div>

  <div class="section">
    <div class="section-header">
      <h2>Content</h2>
      ${entry.content.trim() ? `<button class="copy-btn" data-copy-content="true" title="Copy content">Copy</button>` : ''}
    </div>
    ${renderContent(entry.content)}
  </div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      var content = ${toScriptJson(entry.content)};

      document.addEventListener('click', function(e) {
        var target = e.target;

        if (target.classList && target.classList.contains('copy-btn')) {
          if (target.getAttribute('data-copy-content') === 'true') {
            vscode.postMessage({ type: 'copy', text: content });
          } else {
            var text = target.getAttribute('data-copy');
            if (text) {
              vscode.postMessage({ type: 'copy', text: text });
            }
          }
          return;
        }

        if (target.classList && target.classList.contains('file-link')) {
          e.preventDefault();
          var path = target.getAttribute('data-path');
          if (path) {
            vscode.postMessage({ type: 'openFile', path: path });
          }
          return;
        }
      });
    })();
  </script>
</body>
</html>`;
}
