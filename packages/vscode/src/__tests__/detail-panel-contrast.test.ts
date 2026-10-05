import { beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from 'vscode';
import { MOCK_ENTRIES } from './fixtures/mock-entries';
import {
  MINIMUM_TEXT_CONTRAST,
  failingPairs,
  hardCodedColors,
  textPairs,
} from './helpers/css-contrast';
import { BUILT_IN_THEMES } from './helpers/vscode-theme-defaults';
import { createDetailPanel } from '../webview/detail-panel';

let panelCounter = 0;

/** The stylesheet the detail panel ships, taken from the page it builds. */
function shippedStylesheet(): string {
  (window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValue({
    webview: { html: '', onDidReceiveMessage: vi.fn() },
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    iconPath: undefined,
    dispose: vi.fn(),
  });
  panelCounter += 1;
  const entry = { ...MOCK_ENTRIES[0], id: `contrast-${panelCounter}`, favorite: true };
  const html = createDetailPanel({ subscriptions: [] } as never, entry).webview.html;
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  if (!css) throw new Error('the detail panel page has no <style> block');
  return css;
}

/** The rules of the previous stylesheet that failed WCAG AA, verbatim (CV-G1-022). */
const PREVIOUS_FAILING_RULES = `
    .badge-source {
      background-color: var(--vscode-textBlockQuote-background);
      color: var(--vscode-textBlockQuote-border);
      border: 1px solid var(--vscode-textBlockQuote-border);
    }
    .muted {
      color: var(--vscode-disabledForeground);
      font-style: italic;
    }
    .copy-btn {
      color: var(--vscode-button-foreground);
      background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    }
    .copy-btn:hover {
      background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
`;

/** A type badge of the previous stylesheet, which fixed its text colour whatever the theme. */
const PREVIOUS_HARD_CODED_RULE =
  '.badge-command { background-color: var(--vscode-charts-yellow); color: #000; }';

/** Selectors whose pairs must be measured: a rename must not silently drop them from the check. */
const CHECKED_SELECTORS = [
  '.badge-type',
  '.badge-source',
  '.tag',
  '.muted',
  '.description',
  '.copy-btn',
  '.copy-btn:hover',
  '.file-link',
  '.file-link:hover',
  '.content-block',
  '.info-row',
];

describe('Detail panel stylesheet', () => {
  let css: string;

  beforeEach(() => {
    vi.clearAllMocks();
    css = shippedStylesheet();
  });

  it('hard-codes no colour, so every colour follows the active theme', () => {
    expect(hardCodedColors(css)).toEqual([]);
  });

  it('is measured on every control that had a contrast problem', () => {
    const measured = textPairs(css, BUILT_IN_THEMES[0].colors).map((pair) => pair.selector);

    expect(measured).toEqual(expect.arrayContaining(CHECKED_SELECTORS));
  });

  describe.each(BUILT_IN_THEMES)('in $name', ({ colors }) => {
    it(`gives every text and background pair at least ${MINIMUM_TEXT_CONTRAST}:1`, () => {
      const failures = failingPairs(css, colors).map(
        (pair) =>
          `${pair.selector}: ${pair.foreground} on ${pair.background} = ${pair.ratio.toFixed(2)}:1`,
      );

      expect(failures).toEqual([]);
    });
  });

  describe('the check itself', () => {
    it('reproduces the 1.26:1 copy button of the previous stylesheet in Light Modern', () => {
      const lightModern = BUILT_IN_THEMES.find((theme) => theme.name === 'Light Modern')!;

      const copyButton = textPairs(PREVIOUS_FAILING_RULES, lightModern.colors).find(
        (pair) => pair.selector === '.copy-btn',
      );

      expect(copyButton?.ratio).toBeCloseTo(1.26, 2);
    });

    it('flags the previous stylesheet in at least one built-in theme per failing rule', () => {
      const failing = new Set(
        BUILT_IN_THEMES.flatMap(({ colors }) =>
          failingPairs(PREVIOUS_FAILING_RULES, colors).map((pair) => pair.selector),
        ),
      );

      expect([...failing].sort()).toEqual(
        ['.badge-source', '.copy-btn', '.copy-btn:hover', '.muted'].sort(),
      );
    });

    it('flags the hard-coded colours of the previous stylesheet', () => {
      expect(hardCodedColors(PREVIOUS_HARD_CODED_RULE)).toEqual(['.badge-command { color: #000 }']);
    });

    it('refuses to guess a variable the theme table does not list', () => {
      const unknown = '.x { color: var(--vscode-not-in-the-table); }';

      expect(() => textPairs(unknown, BUILT_IN_THEMES[0].colors)).toThrow(/no entry for/);
    });
  });
});
