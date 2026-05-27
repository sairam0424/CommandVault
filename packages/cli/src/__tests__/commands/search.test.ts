import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MOCK_ENTRIES, mockSearchResults } from '../fixtures/mock-vault.js';
import type { SearchOptions } from '@commandvault/core';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
    withVault: vi.fn(),
  };
});

import { createVaultInstance, withVault } from '../../helpers.js';
import { createSearchCommand } from '../../commands/search.js';
import { Command } from 'commander';

function buildProgram() {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.option('--tier <tier>', 'Search tier');
  program.addCommand(createSearchCommand());
  return program;
}

function createMockVault(searchFn?: (opts: SearchOptions) => any[]) {
  return {
    search: searchFn ?? ((opts: SearchOptions) => mockSearchResults(opts.query)),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function setupVaultMock(vault: ReturnType<typeof createMockVault>) {
  vi.mocked(withVault).mockImplementation(async (_opts, fn) => {
    return fn(vault as any);
  });
  vi.mocked(createVaultInstance).mockResolvedValue(vault as any);
}

describe('search command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('searches by query string and returns matching results', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'search', 'browse']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('result');
    expect(output).toContain('browse');
  });

  it('returns empty results message for no matches', async () => {
    const vault = createMockVault(() => []);
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'search', 'zzzznonexistent']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No results found');
  });

  it('passes type filter alongside query', async () => {
    let capturedOpts: SearchOptions | undefined;
    const vault = createMockVault((opts) => {
      capturedOpts = opts;
      return mockSearchResults(opts.query);
    });
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'search', 'browse', '--type', 'skill']);

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.type).toBe('skill');
  });

  it('outputs JSON when --json flag is set', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', '--json', 'search', 'browse']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('query', 'browse');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('respects --limit option', async () => {
    let capturedOpts: SearchOptions | undefined;
    const vault = createMockVault((opts) => {
      capturedOpts = opts;
      return mockSearchResults(opts.query).slice(0, opts.limit ?? 20);
    });
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'search', 'test', '--limit', '3']);

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.limit).toBe(3);
  });

  it('rejects invalid --limit values', async () => {
    const vault = createMockVault();
    setupVaultMock(vault);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'search', 'test', '--limit', '0']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('--limit must be a number between 1 and 1000');
  });
});
