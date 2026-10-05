import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommandError, EXIT_RUNTIME_ERROR, EXIT_USAGE_ERROR } from '../../errors.js';
import { makeMockEntry } from '../fixtures/mock-vault.js';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return { ...actual, createVaultInstance: vi.fn() };
});

import { createVaultInstance } from '../../helpers.js';
import { createAuditCommand } from '../../commands/audit.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface AuditJson {
  readonly stale: ReadonlyArray<{ readonly name: string }>;
  readonly missing: ReadonlyArray<{ readonly name: string; readonly filePath: string }>;
  readonly summary: Readonly<Record<string, number>>;
}

describe('audit command', () => {
  let home: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-audit-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, '.commandvault'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function useVault(entries: ReturnType<typeof makeMockEntry>[]): void {
    const vault = { getAllEntries: () => entries, dispose: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);
  }

  async function runAudit(...args: string[]): Promise<void> {
    const program = new Command();
    program.option('--json').option('--claude-path <dir>');
    program.addCommand(createAuditCommand());
    await program.parseAsync(['node', 'vault', 'audit', ...args]);
  }

  async function auditJson(...args: string[]): Promise<AuditJson> {
    await runAudit('--json', ...args);
    return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as AuditJson;
  }

  async function failureOf(...args: string[]): Promise<CommandError> {
    try {
      await runAudit(...args);
    } catch (error) {
      return error as CommandError;
    }
    throw new Error('audit did not fail');
  }

  describe('threshold validation', () => {
    it.each([
      ['--threshold', 'abc'],
      ['--threshold', '-1'],
      ['--threshold', '1.5'],
      ['--threshold', '36501'],
      ['--threshold', ''],
      ['--min-score', 'abc'],
      ['--min-score', '-1'],
      ['--min-score', '101'],
    ])('rejects %s %j with a usage error before opening the vault', async (flag, value) => {
      const error = await failureOf(flag, value);

      expect(error.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(error.message).toContain(flag);
      expect(createVaultInstance).not.toHaveBeenCalled();
    });

    it.each([
      ['--threshold', '0'],
      ['--threshold', '36500'],
      ['--min-score', '0'],
      ['--min-score', '100'],
    ])('accepts %s %s', async (flag, value) => {
      useVault([]);

      await expect(runAudit(flag, value)).resolves.toBeUndefined();
    });
  });

  describe('--fail-under', () => {
    const lowQuality = makeMockEntry({
      id: 'low',
      name: 'low',
      content: '',
      description: '',
      filePath: '/nowhere/low.md',
    });

    it('exits 1 when an entry scores below --min-score', async () => {
      useVault([lowQuality]);

      const error = await failureOf('--fail-under', '--min-score', '100');

      expect(error.exitCode).toBe(EXIT_RUNTIME_ERROR);
      expect(error.message).toBe('1 entry scored below 100');
    });

    it('still prints the report and the JSON before failing', async () => {
      useVault([lowQuality]);

      await expect(runAudit('--json', '--fail-under', '--min-score', '100')).rejects.toBeInstanceOf(
        CommandError,
      );
      const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as AuditJson;

      expect(report.summary['lowQualityCount']).toBe(1);
    });

    it('is not a gate unless asked for', async () => {
      useVault([lowQuality]);

      await expect(runAudit('--min-score', '100')).resolves.toBeUndefined();
    });

    it('passes when nothing scores below --min-score', async () => {
      useVault([lowQuality]);

      await expect(runAudit('--fail-under', '--min-score', '0')).resolves.toBeUndefined();
    });
  });

  describe('--json', () => {
    it('lists the entries whose source file is gone', async () => {
      useVault([makeMockEntry({ id: 'gone', name: 'gone', filePath: join(home, 'gone.md') })]);

      const report = await auditJson();

      expect(report.missing).toEqual([{ name: 'gone', filePath: join(home, 'gone.md') }]);
      expect(report.summary['missingCount']).toBe(1);
    });
  });

  describe('hook entries', () => {
    const hook = makeMockEntry({
      id: 'hook',
      name: 'PreToolUse:Bash:echo hi',
      type: 'hook',
      filePath: 'echo hi',
    });

    async function writeSettings(claudeDir: string, ageDays = 0): Promise<void> {
      await mkdir(claudeDir, { recursive: true });
      const settings = join(claudeDir, 'settings.json');
      await writeFile(settings, '{}');
      const when = new Date(Date.now() - ageDays * MS_PER_DAY);
      await utimes(settings, when, when);
    }

    it('are judged by the settings.json of the default Claude directory', async () => {
      await writeSettings(join(home, '.claude'));
      useVault([hook]);

      const report = await auditJson();

      expect(report.missing).toEqual([]);
      expect(report.stale).toEqual([]);
    });

    it('are judged by the settings.json of --claude-path', async () => {
      const elsewhere = join(home, 'elsewhere');
      await writeSettings(elsewhere, 90);
      useVault([hook]);

      const report = await auditJson('--claude-path', elsewhere);

      expect(report.missing).toEqual([]);
      expect(report.stale.map((entry) => entry.name)).toEqual([hook.name]);
    });

    it('are missing when the configured Claude directory has no settings.json', async () => {
      await writeSettings(join(home, '.claude'));
      useVault([hook]);

      const report = await auditJson('--claude-path', join(home, 'elsewhere'));

      expect(report.missing.map((entry) => entry.name)).toEqual([hook.name]);
    });

    it('are judged by the settings.json that config.json names', async () => {
      const configured = join(home, 'configured');
      await writeSettings(configured);
      await mkdir(join(home, '.commandvault'), { recursive: true });
      await writeFile(
        join(home, '.commandvault', 'config.json'),
        JSON.stringify({ claudeConfigPath: configured }),
      );
      useVault([hook]);

      const report = await auditJson();

      expect(report.missing).toEqual([]);
    });
  });
});
