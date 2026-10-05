import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { makeMockEntry } from '../fixtures/mock-vault.js';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return { ...actual, createVaultInstance: vi.fn() };
});

import { createVaultInstance } from '../../helpers.js';
import { createInfoCommand } from '../../commands/info.js';

describe('info command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  async function infoOutput(metadata: Record<string, unknown>): Promise<string> {
    const entry = makeMockEntry({ id: 'e1', name: 'demo', metadata });
    const vault = {
      quickSearch: () => [{ entry, score: 1 }],
      getSlashCommand: () => '/demo',
      recordUsage: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);

    const program = new Command();
    program.option('--json');
    program.addCommand(createInfoCommand());
    await program.parseAsync(['node', 'vault', 'info', 'demo']);
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('prints a metadata field that has a value', async () => {
    const output = await infoOutput({ version: '1.2.0', folderName: 'demo' });

    expect(output).toContain('version');
    expect(output).toContain('1.2.0');
    expect(output).toContain('folderName');
  });

  it('leaves out a field whose value is undefined instead of printing "undefined"', async () => {
    const output = await infoOutput({
      version: undefined,
      triggers: undefined,
      folderName: 'demo',
    });

    expect(output).not.toContain('undefined');
    expect(output).not.toContain('version');
    expect(output).not.toContain('triggers');
    expect(output).toContain('folderName');
  });

  it('still prints falsy values that are real', async () => {
    const output = await infoOutput({ timeout: 0, enabled: false, note: '' });

    expect(output).toContain('timeout');
    expect(output).toContain('enabled');
    expect(output).toContain('note');
  });

  it('shows "(none)" when every field is undefined', async () => {
    const output = await infoOutput({ version: undefined });

    expect(output).toContain('(none)');
    expect(output).not.toContain('undefined');
  });
});
