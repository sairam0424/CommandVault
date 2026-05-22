import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MOCK_ENTRIES, MOCK_STATS, makeMockEntry } from '../fixtures/mock-vault.js';
import type { VaultStats } from '@commandvault/core';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
  };
});

import { createVaultInstance } from '../../helpers.js';
import { createStatsCommand } from '../../commands/stats.js';
import { Command } from 'commander';

function buildProgram() {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createStatsCommand());
  return program;
}

function createMockVault(stats: VaultStats = MOCK_STATS, entries = MOCK_ENTRIES) {
  return {
    getStats: () => stats,
    getAllEntries: () => entries,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('stats command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('returns correct entry counts by type', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'stats']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    // Should display the total count
    expect(output).toContain(String(MOCK_STATS.totalEntries));
    // Should display type names
    expect(output).toContain('skill');
    expect(output).toContain('agent');
    expect(output).toContain('command');
  });

  it('returns correct counts by source', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'stats']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    // Source section header
    expect(output).toContain('Source');
    // Source names from MOCK_STATS
    expect(output).toContain('gstack');
    expect(output).toContain('custom');
  });

  it('shows favorite count', async () => {
    const statsWithFavorites: VaultStats = {
      ...MOCK_STATS,
      favoriteCount: 5,
    };
    const vault = createMockVault(statsWithFavorites);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'stats']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('5');
  });

  it('outputs JSON when --json flag is set', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', '--json', 'stats']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('totalEntries', MOCK_STATS.totalEntries);
    expect(parsed).toHaveProperty('byType');
    expect(parsed).toHaveProperty('bySource');
    expect(parsed).toHaveProperty('favoriteCount');
  });

  it('shows top used entries when usage data exists', async () => {
    const entriesWithUsage = [
      makeMockEntry({ id: 'u1', name: 'popular-skill', usageCount: 50 }),
      makeMockEntry({ id: 'u2', name: 'unused-skill', usageCount: 0 }),
    ];
    const vault = createMockVault(MOCK_STATS, entriesWithUsage);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'stats']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('popular-skill');
    expect(output).toContain('50x');
  });

  it('shows "no usage data" message when all entries have zero usage', async () => {
    const noUsageEntries = [makeMockEntry({ id: 'z1', name: 'zero-usage', usageCount: 0 })];
    const vault = createMockVault(MOCK_STATS, noUsageEntries);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'stats']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No usage data yet');
  });
});
