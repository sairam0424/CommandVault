import * as vscode from 'vscode';
import type { VaultEntry } from '@commandvault/core';

const PANEL_COLUMN = vscode.ViewColumn.One;

const activePanels = new Map<string, vscode.WebviewPanel>();

export function createDetailPanel(
  context: vscode.ExtensionContext,
  entry: VaultEntry
): vscode.WebviewPanel {
  const existingPanel = activePanels.get(entry.id);
  if (existingPanel) {
    existingPanel.reveal(PANEL_COLUMN);
    existingPanel.webview.html = buildHtml(entry);
    return existingPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'commandvault.detail',
    `${entry.name} - CommandVault`,
    PANEL_COLUMN,
    {
      enableScripts: false,
      retainContextWhenHidden: false,
    }
  );

  panel.iconPath = new vscode.ThemeIcon(getIconForType(entry.type));
  panel.webview.html = buildHtml(entry);

  activePanels.set(entry.id, panel);

  panel.onDidDispose(() => {
    activePanels.delete(entry.id);
  }, null, context.subscriptions);

  return panel;
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
  return tags
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join(' ');
}

function renderContent(content: string): string {
  if (!content.trim()) {
    return '<p class="muted">No content available</p>';
  }
  return `<pre class="content-block">${escapeHtml(content)}</pre>`;
}

function buildHtml(entry: VaultEntry): string {
  const typeBadgeClass = `badge badge-type badge-${entry.type}`;
  const sourceBadgeClass = 'badge badge-source';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
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
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge-type {
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .badge-skill { background-color: var(--vscode-charts-green); color: #fff; }
    .badge-agent { background-color: var(--vscode-charts-blue); color: #fff; }
    .badge-command { background-color: var(--vscode-charts-yellow); color: #000; }
    .badge-plugin { background-color: var(--vscode-charts-purple); color: #fff; }
    .badge-rule { background-color: var(--vscode-charts-orange); color: #fff; }
    .badge-hook { background-color: var(--vscode-charts-red); color: #fff; }

    .badge-source {
      background-color: var(--vscode-textBlockQuote-background);
      color: var(--vscode-textBlockQuote-border);
      border: 1px solid var(--vscode-textBlockQuote-border);
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
      color: var(--vscode-disabledForeground);
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
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(entry.name)}</h1>
    <div class="badges">
      <span class="${typeBadgeClass}">${escapeHtml(entry.type)}</span>
      <span class="${sourceBadgeClass}">${escapeHtml(entry.source)}</span>
      ${entry.favorite ? '<span class="badge badge-type">&#9733; Favorite</span>' : ''}
    </div>
    <p class="description">${escapeHtml(entry.description)}</p>
    <p class="file-path">${escapeHtml(entry.filePath)}</p>
    <div class="info-row">
      <span>Used: ${entry.usageCount} times</span>
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
    <h2>Content</h2>
    ${renderContent(entry.content)}
  </div>
</body>
</html>`;
}
