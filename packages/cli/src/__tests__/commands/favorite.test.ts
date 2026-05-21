import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockEntry } from '../fixtures/mock-vault.js';
import type { SearchResult } from '@commandvault/core';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
  };
});

import { createVaultInstance } from '../../helpers.js';
import { createFavoriteCommand } from '../../commands/favorite.js';
import { Command } from 'commander';

function buildProgram() {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createFavoriteCommand());
  return program;
}

const TEST_ENTRY = makeMockEntry({
  id: 'fav-test-1',
  name: 'browse',
  type: 'skill',
  source: 'gstack',
  favorite: false,
});

function createMockVault(options?: { searchResult?: SearchResult[]; toggleResult?: boolean }) {
  const searchResult = options?.searchResult ?? [
    { entry: TEST_ENTRY, score: 1, matchedFields: ['name'] },
  ];
  const toggleResult = options?.toggleResult ?? true;

  return {
    quickSearch: vi.fn().mockReturnValue(searchResult),
    toggleFavorite: vi.fn().mockReturnValue(toggleResult),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('favorite command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('toggles favorite on an entry (adds favorite)', async () => {
    const vault = createMockVault({ toggleResult: true });
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'favorite', 'browse']);

    expect(vault.toggleFavorite).toHaveBeenCalledWith('fav-test-1');
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Favorited');
    expect(output).toContain('browse');
  });

  it('toggles favorite off an entry (removes favorite)', async () => {
    const vault = createMockVault({ toggleResult: false });
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'favorite', 'browse']);

    expect(vault.toggleFavorite).toHaveBeenCalledWith('fav-test-1');
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Unfavorited');
    expect(output).toContain('browse');
  });

  it('reports error for non-existent entry', async () => {
    const vault = createMockVault({ searchResult: [] });
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'favorite', 'nonexistent']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No entry found');
    expect(output).toContain('nonexistent');
    expect(vault.toggleFavorite).not.toHaveBeenCalled();
  });

  it('uses fuzzy search to match entry by name', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'favorite', 'brows']);

    // quickSearch should be called with the fuzzy input
    expect(vault.quickSearch).toHaveBeenCalledWith('brows', 1);
  });

  it('disposes vault after operation completes', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'favorite', 'browse']);

    expect(vault.dispose).toHaveBeenCalledOnce();
  });

  it('disposes vault even when entry is not found', async () => {
    const vault = createMockVault({ searchResult: [] });
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'favorite', 'nothing']);

    expect(vault.dispose).toHaveBeenCalledOnce();
  });
});
