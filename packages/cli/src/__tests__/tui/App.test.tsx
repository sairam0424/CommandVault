import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { VaultEntry, SearchResult } from '@commandvault/core';
import type { Vault } from '@commandvault/core';

// Mock clipboardy so dynamic import() doesn't fail in jsdom
vi.mock('clipboardy', () => ({ default: { write: vi.fn().mockResolvedValue(undefined) } }));

function makeEntry(name: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: name,
    name,
    type: 'skill',
    source: 'custom',
    description: `${name} description`,
    filePath: `/fake/${name}.md`,
    tags: [],
    metadata: {},
    content: `Content of ${name}`,
    lastModified: new Date('2026-01-01'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

function makeVault(entries: VaultEntry[]): Vault {
  return {
    search: vi.fn().mockReturnValue(
      entries.map((e) => ({ entry: e, score: 1, matchedFields: [] as string[] })),
    ),
    getAllEntries: vi.fn().mockReturnValue(entries),
    recordUsage: vi.fn(),
    toggleFavorite: vi.fn().mockReturnValue(true),
    getSlashCommand: vi.fn().mockImplementation((e: VaultEntry) => `/${e.name}`),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Vault;
}

// Lazy import so we can set up mocks first
async function importApp() {
  const mod = await import('../../tui/App.js');
  return mod.App;
}

describe('App', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initial render shows > (search bar prompt)', async () => {
    const App = await importApp();
    const vault = makeVault([makeEntry('alpha'), makeEntry('beta')]);
    const { lastFrame } = render(<App vault={vault} />);
    expect(lastFrame()).toContain('>');
  });

  it('shows entry names when query is empty (most-used default)', async () => {
    const App = await importApp();
    const entries = [
      makeEntry('alpha', { usageCount: 5 }),
      makeEntry('beta', { usageCount: 3 }),
      makeEntry('gamma', { usageCount: 1 }),
    ];
    const vault = makeVault(entries);
    const { lastFrame } = render(<App vault={vault} />);
    const frame = lastFrame() ?? '';
    // At least one entry name should appear in the results list
    expect(frame).toContain('alpha');
  });

  it('shows action bar hints text (Copy or Quit)', async () => {
    const App = await importApp();
    const vault = makeVault([makeEntry('alpha')]);
    const { lastFrame } = render(<App vault={vault} />);
    const frame = lastFrame() ?? '';
    // ActionBar shows either SEARCH_HINTS with "Copy" or fallback "[q Quit]"
    const hasHints = frame.includes('Copy') || frame.includes('Quit') || frame.includes('quit');
    expect(hasHints).toBe(true);
  });

  it('renders without crashing when terminal has normal width', async () => {
    const App = await importApp();
    const vault = makeVault([makeEntry('hello')]);
    // Should render with standard stdout dimensions (no crash)
    const { lastFrame } = render(<App vault={vault} />);
    expect(lastFrame()).toBeTruthy();
  });
});
