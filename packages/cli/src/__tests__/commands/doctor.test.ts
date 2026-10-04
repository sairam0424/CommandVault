import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOCK_ENTRIES } from '../fixtures/mock-vault.js';

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
    // doctor resolves ~/.claude and ~/.commandvault when it runs, so point them at the temp dir.
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    vi.stubEnv('COMMANDVAULT_HOME', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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

  describe('with the directories redirected by environment variables', () => {
    interface ClaudeDirShape {
      readonly skills: number;
      readonly agents: number;
      readonly commands: number;
      readonly installedPlugins: string;
      readonly settings: Record<string, unknown>;
    }

    async function populateClaudeDir(dir: string, shape: ClaudeDirShape): Promise<void> {
      const counts = { skills: shape.skills, agents: shape.agents, commands: shape.commands };
      for (const [folder, count] of Object.entries(counts)) {
        for (let index = 0; index < count; index += 1) {
          await mkdir(join(dir, folder, `${folder}-${index}`), { recursive: true });
        }
      }
      await mkdir(join(dir, 'plugins'), { recursive: true });
      await writeFile(join(dir, 'plugins', 'installed_plugins.json'), shape.installedPlugins);
      await writeFile(join(dir, 'settings.json'), JSON.stringify(shape.settings));
    }

    async function doctorOutput(): Promise<string> {
      vi.mocked(createVaultInstance).mockResolvedValue(createMockVault() as any);
      await buildProgram().parseAsync(['node', 'vault', 'doctor']);
      return consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    }

    const lineFor = (output: string, label: string): string =>
      output.split('\n').find((line) => line.includes(label)) ?? `(no line for ${label})`;

    it('inspects CLAUDE_CONFIG_DIR, not <HOME>/.claude, in every Claude check', async () => {
      // <HOME>/.claude is complete and healthy; the redirected directory differs in every respect
      // a check reports, so a check that still reads <HOME>/.claude prints the wrong detail.
      await populateClaudeDir(join(tmpDir, '.claude'), {
        skills: 1,
        agents: 1,
        commands: 1,
        installedPlugins: '[]',
        settings: { hooks: {} },
      });
      const redirected = join(tmpDir, 'elsewhere', 'claude');
      await populateClaudeDir(redirected, {
        skills: 2,
        agents: 3,
        commands: 4,
        installedPlugins: '{broken json',
        settings: {},
      });
      vi.stubEnv('CLAUDE_CONFIG_DIR', redirected);

      const output = await doctorOutput();

      expect(lineFor(output, '~/.claude/skills/')).toContain('2 skills found');
      expect(lineFor(output, '~/.claude/agents/')).toContain('3 agents found');
      expect(lineFor(output, '~/.claude/commands/')).toContain('4 commands found');
      expect(lineFor(output, 'installed_plugins.json')).toContain('invalid JSON');
      expect(lineFor(output, 'settings.json')).toContain('no hooks section');
    });

    it('reports a missing CLAUDE_CONFIG_DIR even though <HOME>/.claude is healthy', async () => {
      await populateClaudeDir(join(tmpDir, '.claude'), {
        skills: 1,
        agents: 1,
        commands: 1,
        installedPlugins: '[]',
        settings: { hooks: {} },
      });
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(tmpDir, 'missing', 'claude'));

      const output = await doctorOutput();

      expect(lineFor(output, '~/.claude/ directory')).toContain('Directory not found');
      expect(output).not.toMatch(/\d+ (skill|agent|command)s? found/);
      expect(output).not.toContain('Valid');
    });

    it('looks for the vault in COMMANDVAULT_HOME, not <HOME>/.commandvault', async () => {
      const dataDir = join(tmpDir, 'elsewhere', 'data');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'vault.db'), '');
      vi.stubEnv('COMMANDVAULT_HOME', dataDir);

      const output = await doctorOutput();

      expect(lineFor(output, '~/.commandvault/ directory')).toContain('Directory exists');
      expect(lineFor(output, '~/.commandvault/vault.db')).toContain('SQLite database exists');
    });
  });
});
