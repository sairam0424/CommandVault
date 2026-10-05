import { describe, it, expect, vi } from 'vitest';
import type { Vault, VaultEntry } from '@commandvault/core';
import { MOCK_ENTRIES } from './fixtures/mock-entries';
import { HOSTILE_TEXTS, between, unescapedMarkup } from './helpers/hostile-text';
import { documentOf, Position, Uri } from './helpers/vscode-extras';
import type { Hover, MarkdownString } from './helpers/vscode-extras';

vi.mock('vscode', async (importOriginal) =>
  (await import('./helpers/vscode-extras')).withVscodeExtras(await importOriginal<object>()),
);

import { HoverProvider } from '../providers/hover-provider';

const SKILL_NAME = 'review';
const HOVER_LINE = `please run /${SKILL_NAME} today`;
const INSIDE_COMMAND = new Position(0, HOVER_LINE.indexOf('/') + 2);
const OPEN_LINK_LINE = /^\[Open Source File\]\(file:\/\/\/[A-Za-z0-9%._~/-]+\)$/;

function entryWith(overrides: Partial<VaultEntry>): VaultEntry {
  return { ...MOCK_ENTRIES[0], name: SKILL_NAME, ...overrides };
}

function hoverOver(entry: VaultEntry): Hover {
  const vault = { getAllEntries: () => [entry] } as unknown as Vault;
  const provider = new HoverProvider({ current: vault });
  const hover = provider.provideHover(
    documentOf([HOVER_LINE]) as never,
    INSIDE_COMMAND as never,
    {} as never,
  );
  if (!hover) throw new Error('expected a hover over the slash command');
  return hover as unknown as Hover;
}

function markdownOf(hover: Hover): MarkdownString[] {
  return hover.contents.map((content) => {
    if (typeof content === 'string') throw new Error('hover contents must be MarkdownString');
    return content;
  });
}

function hoverValue(entry: VaultEntry): string {
  return markdownOf(hoverOver(entry))
    .map((md) => md.value)
    .join('\n');
}

/** The hover text with the fenced preview removed: what a renderer reads as markdown. */
function outsideFence(value: string): string {
  return value.replace(/(`{3,})text\n[\s\S]*?\n\1\n/, '');
}

describe('HoverProvider', () => {
  describe('trust', () => {
    it('shows name, description and a content preview over a slash command', () => {
      const entry = entryWith({ description: 'Review the diff', content: '# Review\nStep one' });

      const value = hoverValue(entry);

      expect(value).toContain('Review the diff');
      expect(value).toContain('# Review\nStep one');
      const range = hoverOver(entry).range;
      expect(range?.start.character).toBe(HOVER_LINE.indexOf('/'));
      expect(range?.end.character).toBe(HOVER_LINE.indexOf('/') + SKILL_NAME.length + 1);
    });

    it('never marks a hover that contains entry text as trusted', () => {
      const hover = hoverOver(entryWith({ description: 'anything', content: 'anything' }));

      for (const md of markdownOf(hover)) {
        expect(md.isTrusted ?? false).toBe(false);
      }
    });

    it.each(Object.entries(HOSTILE_TEXTS))(
      'offers no command link when the description is hostile (%s)',
      (_label, payload) => {
        const hover = hoverOver(entryWith({ description: `DESCSTART${payload}DESCEND` }));

        for (const md of markdownOf(hover)) {
          expect(md.isTrusted ?? false).toBe(false);
          expect(outsideFence(md.value)).not.toMatch(/command:/i);
        }
      },
    );
  });

  describe('description', () => {
    it.each(Object.entries(HOSTILE_TEXTS))(
      'leaves no markup for a renderer to act on (%s)',
      (_label, payload) => {
        const value = hoverValue(entryWith({ description: `DESCSTART${payload}DESCEND` }));

        const shown = between(value, 'DESCSTART', 'DESCEND');

        expect(unescapedMarkup(shown)).toEqual([]);
        expect(shown).not.toMatch(/[\r\n]/);
      },
    );

    it.each(Object.entries(HOSTILE_TEXTS))(
      'leaves no markup in the entry type either (%s)',
      (_label, payload) => {
        const type = `TYPESTART${payload}TYPEEND` as VaultEntry['type'];

        const value = hoverValue(entryWith({ type }));

        expect(unescapedMarkup(between(value, 'TYPESTART', 'TYPEEND'))).toEqual([]);
      },
    );

    it('escapes the name, which can only contain word characters and hyphens', () => {
      const vault = {
        getAllEntries: () => [entryWith({ name: 'my_skill-x' })],
      } as unknown as Vault;
      const provider = new HoverProvider({ current: vault });

      const hover = provider.provideHover(
        documentOf(['/my_skill-x']) as never,
        new Position(0, 3) as never,
        {} as never,
      ) as unknown as Hover;

      expect(markdownOf(hover)[0].value).toContain('**my\\_skill\\-x**');
    });

    it('keeps the words of the description readable', () => {
      const value = hoverValue(entryWith({ description: 'Plan then build (fast)' }));

      expect(value).toContain('Plan then build \\(fast\\)');
    });
  });

  describe('content preview', () => {
    it('shows only the first ten lines', () => {
      const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

      const value = hoverValue(entryWith({ content }));

      expect(value).toContain('line 10');
      expect(value).not.toContain('line 11');
    });

    it.each([
      ['three backticks', 'before\n```\n[x](command:evil)\n```\nafter'],
      ['a long run', 'x\n```````\n[x](command:evil)\n```````\ny'],
      ['an indented run, which still closes a fence', 'x\n   ```\n[x](command:evil)\n   ```\ny'],
      ['inline backticks', 'use `npm test` then ``code``'],
      ['no backticks', 'plain text'],
    ])('fences the preview with more backticks than it contains (%s)', (_label, content) => {
      const value = hoverValue(entryWith({ content }));

      const opening = /^(`{3,})text$/m.exec(value);
      expect(opening).not.toBeNull();
      const fence = opening![1];
      const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
      expect(fence.length).toBeGreaterThan(longestRun);
      // Only the closing fence may be a line of backticks at least as long as the opening one,
      // whether or not CommonMark's up-to-three-space indent precedes it.
      const closers = value.split('\n').filter((line) => {
        const run = /^ {0,3}(`+)[ \t]*$/.exec(line);
        return run !== null && run[1].length >= fence.length;
      });
      expect(closers).toEqual([fence]);
      expect(between(value, `${fence}text\n`, `\n${fence}`)).toBe(content);
    });
  });

  describe('source file link', () => {
    it('links the source file as a file: URI, not a command', () => {
      const value = hoverValue(entryWith({ filePath: '/home/user/.claude/skills/review.md' }));

      expect(value).toContain('[Open Source File](file:///home/user/.claude/skills/review.md)');
      expect(value).not.toContain('command:');
    });

    it('cannot be made to leave the link by a path with markdown in it', () => {
      const filePath = '/x/a b (1)/`c`/x) [click](https://attacker.example/l) <d>.md';

      const value = hoverValue(entryWith({ filePath }));

      const linkLine = value.split('\n').at(-1) ?? '';
      expect(linkLine).toMatch(OPEN_LINK_LINE);
      expect(linkLine).toContain('a%20b%20%281%29');
    });

    it('drops the link rather than trust an editor URI that is not a plain file URI', () => {
      const unsafe = 'file:///x) [y](command:workbench.action.openSettingsJson';
      const toString = vi.spyOn(Uri.prototype, 'toString').mockReturnValue(unsafe);

      const value = hoverValue(entryWith({ filePath: '/home/user/.claude/skills/review.md' }));

      toString.mockRestore();
      expect(value).not.toContain('Open Source File');
      expect(value).not.toContain('command:');
    });

    it.each([
      ['an imported entry', 'imported:/tmp/bundle.json'],
      ['a relative path', 'skills/review.md'],
      ['a UNC path', '//attacker-host/share/review.md'],
    ])('offers no link for %s', (_label, filePath) => {
      const value = hoverValue(entryWith({ filePath }));

      expect(value).not.toContain('Open Source File');
      expect(value).not.toContain('](');
    });

    it.each([
      ['an unpaired surrogate, which makes Uri.toString throw a URIError', '/x/\ud83d.md'],
      ['four leading slashes, which make Uri.file throw a UriError', '////srv/review.md'],
    ])('still shows the entry, without a link, for a path with %s', (_label, filePath) => {
      const value = hoverValue(entryWith({ filePath, description: 'Review the diff' }));

      expect(value).toContain('Review the diff');
      expect(value).not.toContain('Open Source File');
      expect(value).not.toContain('](');
    });
  });

  it('returns nothing without a vault, outside a command, or for an unknown name', () => {
    const vault = { getAllEntries: () => [entryWith({})] } as unknown as Vault;
    const document = documentOf([HOVER_LINE]) as never;

    const noVault = new HoverProvider({ current: undefined });
    const provider = new HoverProvider({ current: vault });
    const unknown = new HoverProvider({
      current: { getAllEntries: () => [entryWith({ name: 'other' })] } as unknown as Vault,
    });

    expect(noVault.provideHover(document, INSIDE_COMMAND as never, {} as never)).toBeUndefined();
    expect(
      provider.provideHover(document, new Position(0, 1) as never, {} as never),
    ).toBeUndefined();
    expect(unknown.provideHover(document, INSIDE_COMMAND as never, {} as never)).toBeUndefined();
  });
});
