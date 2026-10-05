import { beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from 'vscode';
import type { VaultEntry } from '@commandvault/core';
import { MOCK_ENTRIES } from './fixtures/mock-entries';
import { toScriptJson } from '../webview/script-json';
import { createDetailPanel } from '../webview/detail-panel';

let panelCounter = 0;

function panelHtml(overrides: Partial<VaultEntry>): string {
  (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValue({
    webview: { html: '', onDidReceiveMessage: vi.fn() },
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    iconPath: undefined,
    dispose: vi.fn(),
  });
  panelCounter += 1;
  const entry: VaultEntry = { ...MOCK_ENTRIES[0], id: `script-${panelCounter}`, ...overrides };
  return createDetailPanel({ subscriptions: [] } as never, entry).webview.html;
}

/** The inline script blocks of the page, as an HTML parser would end them. */
function scriptBlocks(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]);
}

/** The value the page's script assigns to `var content`, decoded the way the browser would. */
function embeddedContent(html: string): unknown {
  const [script] = scriptBlocks(html);
  const literal = /var content = (.*);\n/.exec(script)?.[1];
  if (literal === undefined) throw new Error('var content not found in the inline script');
  return JSON.parse(literal);
}

const BREAKOUTS: Readonly<Record<string, string>> = {
  closingScriptThenScript: 'before </script><script>alert(1)</script> after',
  upperCaseClosingTag: 'x </SCRIPT ><img src=x onerror=alert(1)>',
  htmlComment: 'start <!-- <script> comment never closed',
  commentClose: 'a --> b',
  ampersandEntity: '&lt;/script&gt; &amp; &#60;',
  lineSeparators: 'one\u2028two\u2029three',
  cdata: '<![CDATA[ ]]></script>',
};

describe('Detail panel: data embedded in the inline script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(Object.entries(BREAKOUTS))(
    'keeps hostile content inside the one script block (%s)',
    (_label, content) => {
      const html = panelHtml({ content });

      expect(scriptBlocks(html)).toHaveLength(1);
      expect([...html.matchAll(/<script/gi)]).toHaveLength(1);
      expect([...html.matchAll(/<\/script/gi)]).toHaveLength(1);
      expect(scriptBlocks(html)[0]).not.toContain('<!--');
      expect(embeddedContent(html)).toBe(content);
    },
  );

  it('still copies the exact content, whatever it contains', () => {
    const content = BREAKOUTS.closingScriptThenScript + BREAKOUTS.lineSeparators;

    const html = panelHtml({ content });

    expect(embeddedContent(html)).toBe(content);
    expect(html).toContain('data-copy-content="true"');
  });

  it('escapes the content in the visible <pre> block as text', () => {
    const html = panelHtml({ content: BREAKOUTS.closingScriptThenScript });

    expect(html).toContain('before &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; after');
  });

  describe('toScriptJson', () => {
    it.each(Object.entries(BREAKOUTS))('round-trips %s through JSON.parse', (_label, text) => {
      const json = toScriptJson(text);

      expect(JSON.parse(json)).toBe(text);
      expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    });

    it('round-trips structured values and escapes every character that can end a script', () => {
      const value = { a: ['</script>', '<!--'], b: { '\u2028': '&' }, n: 1, t: true, z: null };

      const json = toScriptJson(value);

      expect(JSON.parse(json)).toEqual(value);
      expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    });

    it('writes a missing value as null rather than failing', () => {
      expect(toScriptJson(undefined)).toBe('null');
    });

    it('is not fooled by text that already looks escaped', () => {
      const text = String.raw`</script> \\u003c`;

      expect(JSON.parse(toScriptJson(text))).toBe(text);
    });
  });
});

describe('Detail panel: entry fields in HTML attributes and text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cannot be made to add attributes through the entry type', () => {
    const html = panelHtml({ type: 'skill" onmouseover="alert(1)" data-x="' as never });

    expect(html).not.toMatch(/onmouseover="alert/);
    expect(html).toContain('&quot;');
  });

  it('cannot be made to add markup through the usage count', () => {
    const html = panelHtml({ usageCount: '<img src=x onerror=alert(1)>' as never });

    expect(html).not.toContain('<img src=x');
  });

  it('cannot be made to add markup through the tags, metadata or file path', () => {
    const payload = '"><img src=x onerror=alert(1)>';

    const html = panelHtml({
      tags: [payload],
      metadata: { [payload]: payload },
      filePath: payload,
      source: payload as never,
    });

    expect(html).not.toContain('<img src=x');
    expect([...html.matchAll(/<script/gi)]).toHaveLength(1);
  });
});
