import { describe, it, expect } from 'vitest';
import type { Vault, VaultEntry } from '@commandvault/core';
import { EntriesProvider } from '../providers/entries-provider';
import { FavoritesProvider } from '../providers/favorites-provider';
import { RecentProvider } from '../providers/recent-provider';
import { createMockVault, MOCK_ENTRIES } from './fixtures/mock-entries';
import { HOSTILE_TEXTS, between, unescapedMarkup } from './helpers/hostile-text';

/**
 * The tree tooltips are markdown too. They are never trusted, so a `command:` link cannot run, but
 * entry text that reads as markdown still renders: a link that looks like part of the entry and
 * leads to a phishing page, or headings and lists that fake the tooltip's own layout.
 */

interface TooltipSource {
  readonly label: string;
  readonly tooltipOf: (entry: VaultEntry) => { readonly value: string; isTrusted?: unknown };
}

const vault = createMockVault() as unknown as Vault;

const SOURCES: readonly TooltipSource[] = [
  {
    label: 'EntriesProvider',
    tooltipOf: (entry) =>
      new EntriesProvider(vault).getTreeItem({ kind: 'entry', entry } as never).tooltip as never,
  },
  {
    label: 'FavoritesProvider',
    tooltipOf: (entry) => new FavoritesProvider(vault).getTreeItem(entry).tooltip as never,
  },
  {
    label: 'RecentProvider',
    tooltipOf: (entry) => new RecentProvider(vault).getTreeItem(entry).tooltip as never,
  },
];

function hostileEntry(payload: string): VaultEntry {
  return {
    ...MOCK_ENTRIES[0],
    name: `NAMESTART${payload}NAMEEND`,
    type: `TYPESTART${payload}TYPEEND` as never,
    source: `SOURCESTART${payload}SOURCEEND` as never,
    description: `DESCSTART${payload}DESCEND`,
    tags: [`TAGSTART${payload}TAGEND`],
    filePath: `/PATHSTART${payload}PATHEND`,
    usageCount: `USEDSTART${payload}USEDEND` as never,
  };
}

describe.each(SOURCES)('$label tooltip', ({ tooltipOf }) => {
  it.each(Object.entries(HOSTILE_TEXTS))(
    'leaves no markup for a renderer to act on (%s)',
    (_label, payload) => {
      const tooltip = tooltipOf(hostileEntry(payload));

      expect(tooltip.isTrusted ?? false).toBe(false);
      for (const [start, end] of [
        ['NAMESTART', 'NAMEEND'],
        ['DESCSTART', 'DESCEND'],
      ]) {
        const shown = between(tooltip.value, start, end);
        expect(unescapedMarkup(shown), start).toEqual([]);
        expect(shown, start).not.toMatch(/[\r\n]/);
      }
    },
  );

  it.each(Object.entries(HOSTILE_TEXTS))(
    'escapes the entry type and source too (%s)',
    (_label, payload) => {
      const tooltip = tooltipOf(hostileEntry(payload));

      for (const [start, end] of [
        ['TYPESTART', 'TYPEEND'],
        ['SOURCESTART', 'SOURCEEND'],
      ]) {
        expect(unescapedMarkup(between(tooltip.value, start, end)), start).toEqual([]);
      }
    },
  );

  it('still shows the entry name and description', () => {
    const tooltip = tooltipOf({ ...MOCK_ENTRIES[0], name: 'review', description: 'Review a diff' });

    expect(tooltip.value).toContain('review');
    expect(tooltip.value).toContain('Review a diff');
  });
});

describe('RecentProvider tooltip details', () => {
  it.each(Object.entries(HOSTILE_TEXTS))('escapes the usage count too (%s)', (_label, payload) => {
    const tooltip = SOURCES[2].tooltipOf(hostileEntry(payload));

    expect(unescapedMarkup(between(tooltip.value, 'USEDSTART', 'USEDEND'))).toEqual([]);
  });
});

describe.each([SOURCES[0], SOURCES[1]])('$label tooltip tags', ({ tooltipOf }) => {
  it.each(Object.entries(HOSTILE_TEXTS))('escapes the tags too (%s)', (_label, payload) => {
    const tooltip = tooltipOf(hostileEntry(payload));

    expect(unescapedMarkup(between(tooltip.value, 'TAGSTART', 'TAGEND'))).toEqual([]);
  });
});

describe('EntriesProvider tooltip details', () => {
  it.each(Object.entries(HOSTILE_TEXTS))('escapes the file path too (%s)', (_label, payload) => {
    const tooltip = SOURCES[0].tooltipOf(hostileEntry(payload));

    expect(unescapedMarkup(between(tooltip.value, 'PATHSTART', 'PATHEND'))).toEqual([]);
  });
});
