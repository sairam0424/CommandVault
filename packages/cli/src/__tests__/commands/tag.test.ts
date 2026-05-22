import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MOCK_ENTRIES, makeMockEntry } from '../fixtures/mock-vault.js';
import type { SearchResult } from '@commandvault/core';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
  };
});

import { createVaultInstance } from '../../helpers.js';
import { createTagCommand } from '../../commands/tag.js';
import { Command } from 'commander';

function buildProgram() {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createTagCommand());
  return program;
}

const TEST_ENTRY = makeMockEntry({
  id: 'tag-test-1',
  name: 'browse',
  type: 'skill',
  source: 'gstack',
  tags: ['browser', 'testing'],
});

function createMockVault(options?: { searchResult?: SearchResult[]; tags?: string[] }) {
  const searchResult = options?.searchResult ?? [
    { entry: TEST_ENTRY, score: 1, matchedFields: ['name'] },
  ];
  const userTags = options?.tags ?? [];

  return {
    quickSearch: vi.fn().mockReturnValue(searchResult),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    getEntry: vi.fn().mockReturnValue(TEST_ENTRY),
    getTagsForEntry: vi.fn().mockReturnValue(userTags),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('tag command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('adds a tag to an entry', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'tag', 'add', 'browse', 'my-tag']);

    expect(vault.addTag).toHaveBeenCalledWith('tag-test-1', 'my-tag');
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Added tag');
    expect(output).toContain('my-tag');
    expect(output).toContain('browse');
  });

  it('removes a tag from an entry', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'tag', 'remove', 'browse', 'old-tag']);

    expect(vault.removeTag).toHaveBeenCalledWith('tag-test-1', 'old-tag');
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Removed tag');
    expect(output).toContain('old-tag');
  });

  it('lists tags for an entry', async () => {
    const entryWithTags = makeMockEntry({
      id: 'tag-test-1',
      name: 'browse',
      type: 'skill',
      tags: ['browser', 'testing', 'user-added'],
    });
    const vault = createMockVault({
      searchResult: [{ entry: entryWithTags, score: 1, matchedFields: ['name'] }],
      tags: ['user-added'],
    });
    vault.getEntry.mockReturnValue(entryWithTags);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'tag', 'list', 'browse']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Tags for');
    expect(output).toContain('browse');
    expect(output).toContain('browser');
    expect(output).toContain('user-added');
  });

  it('rejects empty tag name on add', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    // No tag argument provided
    await program.parseAsync(['node', 'vault', 'tag', 'add', 'browse']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Usage: vault tag add <name> <tag>');
    expect(vault.addTag).not.toHaveBeenCalled();
  });

  it('reports error for non-existent entry', async () => {
    const vault = createMockVault({ searchResult: [] });
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'tag', 'add', 'nonexistent', 'my-tag']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No entry found');
  });

  it('rejects unknown action', async () => {
    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'tag', 'invalid-action', 'browse', 'tag']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Unknown action');
  });
});
