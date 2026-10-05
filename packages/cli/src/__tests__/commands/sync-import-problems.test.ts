import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { Command } from 'commander';
import type { ParseError } from '@commandvault/core';
import { CommandError } from '../../errors.js';
import { makeMockEntry } from '../fixtures/mock-vault.js';

const core = vi.hoisted(() => ({ importFromUrl: vi.fn(), importFromFile: vi.fn() }));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  importFromUrl: core.importFromUrl,
  importFromFile: core.importFromFile,
}));

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return { ...actual, createVaultInstance: vi.fn() };
});

import { createVaultInstance } from '../../helpers.js';
import { createImportCommand } from '../../commands/import-cmd.js';
import { createSyncCommand } from '../../commands/sync.js';

const WARNING: ParseError = { filePath: 'x', message: 'record trimmed', severity: 'warning' };
const ERROR: ParseError = { filePath: 'x', message: 'bad record', severity: 'error' };
const ENTRY = makeMockEntry({ id: 'e1', name: 'one' });

describe('sync and import present parse problems by severity', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let previousLevel: typeof chalk.level;
  const addEntries = vi.fn();

  beforeEach(() => {
    previousLevel = chalk.level;
    chalk.level = 1;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    addEntries.mockResolvedValue(1);
    vi.mocked(createVaultInstance).mockResolvedValue({
      addEntries,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    chalk.level = previousLevel;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const stderr = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

  async function run(command: Command, ...args: string[]): Promise<void> {
    const program = new Command();
    program.option('--json');
    program.addCommand(command);
    await program.parseAsync(['node', 'vault', command.name(), '--json', ...args]);
  }

  describe('import', () => {
    it('prints a warning in yellow, not red, and still imports', async () => {
      core.importFromFile.mockResolvedValue({ entries: [ENTRY], errors: [WARNING] });

      await run(createImportCommand(), 'bundle.vault.json');

      expect(stderr()).toContain(chalk.yellow('  ⚠ record trimmed'));
      expect(stderr()).not.toContain(chalk.red('  ⚠ record trimmed'));
      expect(stderr()).toContain('0 errors, 1 warning');
      expect(addEntries).toHaveBeenCalledWith([ENTRY]);
    });

    it('prints an error in red and counts both kinds', async () => {
      core.importFromFile.mockResolvedValue({ entries: [ENTRY], errors: [WARNING, ERROR] });

      await run(createImportCommand(), 'bundle.vault.json');

      expect(stderr()).toContain(chalk.red('  ✗ bad record'));
      expect(stderr()).toContain(chalk.yellow('  ⚠ record trimmed'));
      expect(stderr()).toContain('1 error, 1 warning');
    });

    it('treats a problem without a severity as an error', async () => {
      core.importFromFile.mockResolvedValue({
        entries: [ENTRY],
        errors: [{ filePath: 'x', message: 'legacy' }],
      });

      await run(createImportCommand(), 'bundle.vault.json');

      expect(stderr()).toContain(chalk.red('  ✗ legacy'));
    });

    it('names the error, not an earlier warning, when nothing can be imported', async () => {
      core.importFromFile.mockResolvedValue({ entries: [], errors: [WARNING, ERROR] });

      const failure = run(createImportCommand(), 'bundle.vault.json');

      await expect(failure).rejects.toThrow('no valid entries found in source (bad record)');
    });
  });

  describe('sync', () => {
    const URL = 'https://example.com/registry.vault.json';

    it('does not abort on a warning, and shows it in yellow', async () => {
      core.importFromUrl.mockResolvedValue({ entries: [ENTRY], errors: [WARNING] });

      await run(createSyncCommand(), URL);

      expect(stderr()).toContain(chalk.yellow('  ⚠ record trimmed'));
      expect(addEntries).toHaveBeenCalledWith([ENTRY]);
    });

    it('fails with the error message, not an earlier warning, when nothing was fetched', async () => {
      core.importFromUrl.mockResolvedValue({ entries: [], errors: [WARNING, ERROR] });

      const failure = run(createSyncCommand(), URL);

      await expect(failure).rejects.toBeInstanceOf(CommandError);
      await expect(failure).rejects.toThrow('bad record');
      expect(addEntries).not.toHaveBeenCalled();
    });

    it('still aborts, saving nothing, when any record failed next to valid ones', async () => {
      core.importFromUrl.mockResolvedValue({ entries: [ENTRY], errors: [WARNING, ERROR] });

      const failure = run(createSyncCommand(), URL);

      await expect(failure).rejects.toBeInstanceOf(CommandError);
      await expect(failure).rejects.toThrow('bad record');
      expect(addEntries).not.toHaveBeenCalled();
    });

    it('reports a warning-only empty result as empty, not as a failure', async () => {
      core.importFromUrl.mockResolvedValue({ entries: [], errors: [WARNING] });

      await expect(run(createSyncCommand(), URL)).resolves.toBeUndefined();
      expect(addEntries).not.toHaveBeenCalled();
    });
  });
});
