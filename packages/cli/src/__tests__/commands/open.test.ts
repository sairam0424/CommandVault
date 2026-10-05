import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { Command } from 'commander';
import { makeMockEntry } from '../fixtures/mock-vault.js';

vi.mock('../../editor.js', () => ({ openInEditor: vi.fn() }));
vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return { ...actual, createVaultInstance: vi.fn() };
});

import { openInEditor } from '../../editor.js';
import { createVaultInstance } from '../../helpers.js';
import { CommandError } from '../../errors.js';
import { createOpenCommand } from '../../commands/open.js';

const MISSING_FILE = join('/nonexistent', 'commandvault-open-test', 'SKILL.md');

function createMockVault(filePath: string) {
  const entry = makeMockEntry({ id: 'open-1', name: 'browse', filePath });
  return {
    quickSearch: vi.fn().mockReturnValue([{ entry, score: 1, matchedFields: ['name'] }]),
    recordUsage: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function run(): Promise<Command> {
  const program = new Command();
  program.addCommand(createOpenCommand());
  return program.parseAsync(['node', 'vault', 'open', 'browse']);
}

describe('open command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fails with exit 1, without launching the editor, when the entry file is gone', async () => {
    const vault = createMockVault(MISSING_FILE);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);

    await expect(run()).rejects.toMatchObject({
      message: `file not found or not readable: ${MISSING_FILE}`,
      exitCode: 1,
    });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(vault.recordUsage).not.toHaveBeenCalled();
    expect(vault.dispose).toHaveBeenCalledOnce();
  });

  it('launches the editor and records usage when the entry file is readable', async () => {
    const vault = createMockVault(import.meta.filename);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run();

    log.mockRestore();
    expect(openInEditor).toHaveBeenCalledWith(import.meta.filename);
    expect(vault.recordUsage).toHaveBeenCalledWith('open-1');
  });

  it('fails with exit 1 and records no usage when the editor cannot be launched', async () => {
    const vault = createMockVault(import.meta.filename);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);
    vi.mocked(openInEditor).mockImplementationOnce(() => {
      throw new CommandError('failed to open editor (nope): command not found');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(run()).rejects.toMatchObject({
      message: 'failed to open editor (nope): command not found',
      exitCode: 1,
    });

    log.mockRestore();
    expect(vault.recordUsage).not.toHaveBeenCalled();
    expect(vault.dispose).toHaveBeenCalledOnce();
  });
});
