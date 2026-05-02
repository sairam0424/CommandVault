import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window } from 'vscode';
import type { VaultEntry } from '@commandvault/core';
import { MOCK_ENTRIES } from './fixtures/mock-entries';

vi.mock('crypto', () => ({
  randomBytes: () => ({
    toString: () => 'abc123nonce',
  }),
}));

function importDetailPanel() {
  return import('../webview/detail-panel');
}

function createMockContext() {
  return {
    subscriptions: [] as { dispose: () => void }[],
    extensionUri: { fsPath: '/mock/extension' },
    extensionPath: '/mock/extension',
  };
}

describe('Detail Panel', () => {
  let createDetailPanel: typeof import('../webview/detail-panel').createDetailPanel;
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const mockPanel = {
      webview: {
        html: '',
        onDidReceiveMessage: vi.fn(),
      },
      reveal: vi.fn(),
      onDidDispose: vi.fn(),
      iconPath: undefined as unknown,
      dispose: vi.fn(),
    };

    (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValue(mockPanel);

    const mod = await importDetailPanel();
    createDetailPanel = mod.createDetailPanel;
    mockContext = createMockContext();
  });

  function getPanelHtml(entry: VaultEntry): string {
    const panel = createDetailPanel(mockContext as any, entry);
    return panel.webview.html;
  }

  describe('HTML escaping', () => {
    it('escapes script tags in entry name', () => {
      const xssEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        name: '<script>alert("xss")</script>',
      };
      const html = getPanelHtml(xssEntry);

      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes HTML in description', () => {
      const xssEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        description: '<img src=x onerror=alert(1)>',
      };
      const html = getPanelHtml(xssEntry);

      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img');
    });

    it('escapes HTML in content', () => {
      const xssEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        content: '<div onclick="evil()">Click</div>',
      };
      const html = getPanelHtml(xssEntry);

      expect(html).toContain('&lt;div onclick=');
    });
  });

  describe('tags rendering', () => {
    it('renders tags when present', () => {
      const entry = MOCK_ENTRIES[0];
      const html = getPanelHtml(entry);

      for (const tag of entry.tags) {
        expect(html).toContain(`<span class="tag">${tag}</span>`);
      }
    });

    it('renders "None" when tags are empty', () => {
      const noTagsEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        tags: [],
      };
      const html = getPanelHtml(noTagsEntry);

      expect(html).toContain('None');
    });
  });

  describe('metadata rendering', () => {
    it('renders metadata keys sorted alphabetically', () => {
      const entry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        metadata: { zzzkey: 'z', aaakey: 'a', mmmkey: 'm' },
      };
      const html = getPanelHtml(entry);

      const aaaIdx = html.indexOf('aaakey');
      const mmmIdx = html.indexOf('mmmkey');
      const zzzIdx = html.indexOf('zzzkey');

      expect(aaaIdx).toBeGreaterThan(-1);
      expect(mmmIdx).toBeGreaterThan(-1);
      expect(zzzIdx).toBeGreaterThan(-1);
      expect(aaaIdx).toBeLessThan(mmmIdx);
      expect(mmmIdx).toBeLessThan(zzzIdx);
    });

    it('shows "No metadata" when metadata is empty', () => {
      const entry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        metadata: {},
      };
      const html = getPanelHtml(entry);

      expect(html).toContain('No metadata');
    });

    it('serializes object metadata values as JSON', () => {
      const entry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        metadata: { nested: { key: 'value' } },
      };
      const html = getPanelHtml(entry);

      expect(html).toContain('&quot;key&quot;');
      expect(html).toContain('&quot;value&quot;');
    });
  });

  describe('content rendering', () => {
    it('shows "No content available" for empty content', () => {
      const emptyContent: VaultEntry = {
        ...MOCK_ENTRIES[0],
        content: '',
      };
      const html = getPanelHtml(emptyContent);

      expect(html).toContain('No content available');
    });

    it('shows "No content available" for whitespace-only content', () => {
      const whitespaceContent: VaultEntry = {
        ...MOCK_ENTRIES[0],
        content: '   \n  \t  ',
      };
      const html = getPanelHtml(whitespaceContent);

      expect(html).toContain('No content available');
    });

    it('renders content in a pre block when present', () => {
      const entry = MOCK_ENTRIES[0];
      const html = getPanelHtml(entry);

      expect(html).toContain('<pre class="content-block">');
      expect(html).toContain('# Review');
    });

    it('includes copy button when content exists', () => {
      const entry = MOCK_ENTRIES[0];
      const html = getPanelHtml(entry);

      expect(html).toContain('data-copy-content="true"');
    });

    it('omits copy button when content is empty', () => {
      const emptyContent: VaultEntry = {
        ...MOCK_ENTRIES[0],
        content: '',
      };
      const html = getPanelHtml(emptyContent);

      expect(html).not.toContain('data-copy-content="true"');
    });
  });

  describe('type badge classes', () => {
    it('applies correct badge class for each type', () => {
      const types = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'] as const;

      for (const type of types) {
        const entry: VaultEntry = {
          ...MOCK_ENTRIES[0],
          id: `test-${type}`,
          type,
        };
        const html = getPanelHtml(entry);

        expect(html).toContain(`badge-${type}`);
      }
    });
  });

  describe('favorite badge', () => {
    it('shows favorite star badge when entry is favorited', () => {
      const favEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        favorite: true,
      };
      const html = getPanelHtml(favEntry);

      expect(html).toContain('Favorite');
      expect(html).toContain('&#9733;');
    });

    it('omits favorite badge when not favorited', () => {
      const nonFavEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        favorite: false,
      };
      const html = getPanelHtml(nonFavEntry);

      expect(html).not.toContain('&#9733; Favorite');
    });
  });

  describe('CSP nonce', () => {
    it('includes nonce in Content-Security-Policy and script tag', () => {
      const html = getPanelHtml(MOCK_ENTRIES[0]);

      expect(html).toContain("script-src 'nonce-abc123nonce'");
      expect(html).toContain('nonce="abc123nonce"');
    });
  });
});
