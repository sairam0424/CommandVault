import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MOCK_ENTRIES, makeMockEntry } from '../fixtures/mock-vault.js';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
    withVault: vi.fn(),
  };
});

import { createVaultInstance, withVault } from '../../helpers.js';
import { createListCommand } from '../../commands/list.js';
import { Command } from 'commander';

function buildProgram() {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createListCommand());
  return program;
}

function createMockVault(entries = MOCK_ENTRIES) {
  return {
    getAllEntries: () => entries,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function setupVaultMock(vault: ReturnType<typeof createMockVault>) {
  vi.mocked(withVault).mockImplementation(async (_opts, fn) => {
    return fn(vault as any);
  });
  vi.mocked(createVaultInstance).mockResolvedValue(vault as any);
}

describe('list command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('lists all entries when no filters specified', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'list']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain(`Total: ${MOCK_ENTRIES.length} entries`);
    expect(withVault).toHaveBeenCalled();
  });

  it('filters by type (--type skill)', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'list', '--type', 'skill']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    const skillCount = MOCK_ENTRIES.filter((e) => e.type === 'skill').length;
    expect(output).toContain(`Total: ${skillCount} entries`);
  });

  it('filters by source (--source gstack)', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'list', '--source', 'gstack']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    const gstackCount = MOCK_ENTRIES.filter((e) => e.source === 'gstack').length;
    expect(output).toContain(`Total: ${gstackCount} entries`);
  });

  it('shows empty message when no entries match filter', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'list', '--source', 'nonexistent']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No entries found matching your filters');
  });

  it('outputs JSON when --json flag is set', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', '--json', 'list']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('entries');
    expect(parsed.entries).toHaveLength(MOCK_ENTRIES.length);
  });

  it('rejects invalid type values', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'list', '--type', 'invalid']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Invalid type');
    expect(output).toContain('Valid types');
  });

  it('filters by favorites (--favorites)', async () => {
    const entriesWithFav = [
      ...MOCK_ENTRIES.slice(0, 2),
      makeMockEntry({ id: 'fav1', name: 'my-fav', favorite: true }),
    ];
    const vault = createMockVault(entriesWithFav);
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'list', '--favorites']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Total: 1 entries');
  });
});
