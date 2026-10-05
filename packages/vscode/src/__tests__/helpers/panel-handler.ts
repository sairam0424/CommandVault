import { vi } from 'vitest';
import { window } from 'vscode';
import type { VaultEntry } from '@commandvault/core';
import { MOCK_ENTRIES } from '../fixtures/mock-entries';
import { createDetailPanel } from '../../webview/detail-panel';

export type MessageHandler = (message: Record<string, unknown>) => Promise<void>;

let panelCounter = 0;

/**
 * A detail panel for a fresh entry id (panels are cached per id) and the handler it registered for
 * messages from the webview. Calls the real createDetailPanel, so the handler is the shipped one.
 */
export function openPanelHandler(): MessageHandler {
  const onDidReceiveMessage = vi.fn();
  (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValue({
    webview: { html: '', onDidReceiveMessage },
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    iconPath: undefined,
    dispose: vi.fn(),
  });
  panelCounter += 1;
  const entry: VaultEntry = { ...MOCK_ENTRIES[0], id: `panel-handler-${panelCounter}` };
  createDetailPanel({ subscriptions: [] } as never, entry);
  return onDidReceiveMessage.mock.calls[0][0] as MessageHandler;
}
