import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOCK_ENTRIES } from '../fixtures/mock-vault.js';

const _testHomeDir = vi.hoisted(() => ({ value: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => _testHomeDir.value,
  };
});

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
  };
});

import { createVaultInstance } from '../../helpers.js';
import { createDoctorCommand } from '../../commands/doctor.js';
import { Command } from 'commander';

function buildProgram() {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createDoctorCommand());
  return program;
}

function createMockVault(entries = MOCK_ENTRIES) {
  return {
    getAllEntries: () => entries,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('doctor command', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vault-doctor-test-'));
    _testHomeDir.value = tmpDir;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports healthy status when all checks pass', async () => {
    // Create all expected directories and files
    const claudeDir = join(tmpDir, '.claude');
    await mkdir(join(claudeDir, 'skills'), { recursive: true });
    await mkdir(join(claudeDir, 'agents'), { recursive: true });
    await mkdir(join(claudeDir, 'commands'), { recursive: true });
    await mkdir(join(claudeDir, 'plugins'), { recursive: true });
    await mkdir(join(tmpDir, '.commandvault'), { recursive: true });

    await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify([]));
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: {} }));
    await writeFile(join(tmpDir, '.commandvault', 'vault.db'), '');

    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'doctor']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('checks passed');
  });

  it('detects missing ~/.claude directory', async () => {
    // Don't create .claude directory
    await mkdir(join(tmpDir, '.commandvault'), { recursive: true });
    await writeFile(join(tmpDir, '.commandvault', 'vault.db'), '');

    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'doctor']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('~/.claude/ directory');
    expect(output).toContain('not found');
  });

  it('detects missing vault.db', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    // Don't create .commandvault directory or vault.db

    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'doctor']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('vault.db');
    expect(output).toContain('Not found');
  });

  it('reports scan pipeline failure when vault throws', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await mkdir(claudeDir, { recursive: true });

    vi.mocked(createVaultInstance).mockRejectedValue(new Error('DB corrupted'));

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'doctor']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Vault scan pipeline');
    expect(output).toContain('DB corrupted');
  });

  it('detects invalid plugins JSON', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await mkdir(join(claudeDir, 'plugins'), { recursive: true });
    await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), '{broken json!!!');
    await mkdir(join(tmpDir, '.commandvault'), { recursive: true });
    await writeFile(join(tmpDir, '.commandvault', 'vault.db'), '');

    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'doctor']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('installed_plugins.json');
    expect(output).toContain('invalid JSON');
  });

  it('reports scan entry count on success', async () => {
    const claudeDir = join(tmpDir, '.claude');
    await mkdir(claudeDir, { recursive: true });

    const vault = createMockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as any);

    const program = buildProgram();
    await program.parseAsync(['node', 'vault', 'doctor']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain(`${MOCK_ENTRIES.length} entries successfully`);
  });
});
