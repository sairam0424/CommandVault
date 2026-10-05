import { describe, it, expect, vi } from 'vitest';
import type { Vault, VaultEntry } from '@commandvault/core';
import { MOCK_ENTRIES } from './fixtures/mock-entries';
import { HOSTILE_TEXTS } from './helpers/hostile-text';
import { documentOf } from './helpers/vscode-extras';
import type { DocumentLink } from './helpers/vscode-extras';

vi.mock('vscode', async (importOriginal) =>
  (await import('./helpers/vscode-extras')).withVscodeExtras(await importOriginal<object>()),
);

import { LinkProvider } from '../providers/link-provider';

function entryWith(overrides: Partial<VaultEntry>): VaultEntry {
  return { ...MOCK_ENTRIES[0], name: 'review', ...overrides };
}

function linksIn(lines: readonly string[], entries: readonly VaultEntry[]): DocumentLink[] {
  const vault = { getAllEntries: () => entries } as unknown as Vault;
  const provider = new LinkProvider({ current: vault });
  return provider.provideDocumentLinks(documentOf(lines) as never, {} as never) as never;
}

describe('LinkProvider', () => {
  it('links a known slash command to its source file', () => {
    const entry = entryWith({ filePath: '/home/user/.claude/skills/review.md' });

    const [link] = linksIn(['run /review now'], [entry]);

    expect(link.range.start.character).toBe(4);
    expect(link.range.end.character).toBe(11);
    expect(link.target?.scheme).toBe('file');
    expect(link.target?.path).toBe('/home/user/.claude/skills/review.md');
    expect(link.tooltip).toBe('Open review source file');
  });

  it('runs no command and carries no entry data in the link target', () => {
    const hostile = HOSTILE_TEXTS.commandLink;
    const entry = entryWith({
      description: hostile,
      content: hostile,
      metadata: { note: hostile },
    });

    const [link] = linksIn(['run /review now'], [entry]);

    const target = link.target?.toString() ?? '';
    expect(link.target?.scheme).not.toBe('command');
    expect(target).not.toContain('command');
    expect(target).not.toContain(encodeURIComponent(hostile));
    expect(target.length).toBeLessThan(200);
  });

  it('keeps the link small however large the entry is', () => {
    const entry = entryWith({ content: 'x'.repeat(2_000_000) });

    const links = linksIn(['/review /review /review'], [entry]);

    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.target?.toString().length).toBeLessThan(200);
    }
  });

  it.each([
    ['an imported entry', 'imported:/tmp/bundle.json'],
    ['a relative path', 'skills/review.md'],
    ['a UNC path', '//attacker-host/share/review.md'],
  ])('offers no link for %s, which has no local file to open', (_label, filePath) => {
    expect(linksIn(['run /review now'], [entryWith({ filePath })])).toEqual([]);
  });

  it.each([
    ['an unpaired surrogate, which makes Uri.toString throw a URIError', '/x/\ud83d.md'],
    ['four leading slashes, which make Uri.file throw a UriError', '////srv/odd.md'],
  ])('keeps the other links of the document when one path has %s', (_label, filePath) => {
    const good = entryWith({ name: 'good', filePath: '/home/user/.claude/skills/good.md' });
    const odd = entryWith({ name: 'odd', filePath });

    const links = linksIn(['use /good and /odd'], [good, odd]);

    expect(links).toHaveLength(1);
    expect(links[0].tooltip).toBe('Open good source file');
  });

  it('ignores slash words that are not entries and documents without a vault', () => {
    const entry = entryWith({});

    expect(linksIn(['/unknown /tmp/x'], [entry])).toEqual([]);
    const noVault = new LinkProvider({ current: undefined });
    expect(noVault.provideDocumentLinks(documentOf(['/review']) as never, {} as never)).toEqual([]);
  });
});
