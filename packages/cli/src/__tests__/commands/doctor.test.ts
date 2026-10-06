import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { DatabaseIoError, DatabaseLockedError, type ParseError } from '@commandvault/core';

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return { ...actual, createConfiguredVault: vi.fn() };
});

import { createConfiguredVault } from '../../helpers.js';
import { checkNodeVersion, createDoctorCommand } from '../../commands/doctor.js';

interface Row {
  readonly name: string;
  readonly status: string;
  readonly detail: string;
}

interface Report {
  readonly claudeDir: string;
  readonly checks: readonly Row[];
  readonly counts: Readonly<Record<string, number>>;
  readonly problems: ReadonlyArray<{ readonly filePath: string; readonly message: string }>;
}

function fakeVault(totalEntries: number, errors: readonly ParseError[] = []) {
  return {
    initialize: vi.fn().mockResolvedValue({ totalEntries }),
    getErrors: () => errors,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('doctor command', () => {
  let home: string;
  let claudeDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vault-doctor-test-'));
    claudeDir = join(home, '.claude');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('COMMANDVAULT_HOME', join(home, '.commandvault'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(join(home, '.commandvault'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(createConfiguredVault).mockResolvedValue(fakeVault(3) as never);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function runDoctor(...args: string[]): Promise<Report> {
    const program = new Command();
    program.option('--json').option('--claude-path <dir>');
    program.addCommand(createDoctorCommand());
    await program.parseAsync(['node', 'vault', 'doctor', '--json', ...args]);
    return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Report;
  }

  const rowNamed = (report: Report, name: string): Row =>
    report.checks.find((row) => row.name === name) as Row;

  describe('the Node.js check', () => {
    it('fails below the floor named in the package engines', () => {
      expect(checkNodeVersion('20.18.0', '>=22.13.0').status).toBe('fail');
      expect(checkNodeVersion('22.12.9', '>=22.13.0').status).toBe('fail');
      expect(checkNodeVersion('21.9.0', '>=22.13.0').detail).toContain('>=22.13.0');
    });

    it('passes at and above the floor', () => {
      expect(checkNodeVersion('22.13.0', '>=22.13.0').status).toBe('pass');
      expect(checkNodeVersion('22.14.0', '>=22.13.0').status).toBe('pass');
      expect(checkNodeVersion('24.0.0', '>=22.13.0').status).toBe('pass');
    });

    it('reads the floor from the CLI package.json when none is given', () => {
      const manifest = JSON.parse(
        readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
      ) as { engines: { node: string } };

      expect(checkNodeVersion('99.0.0').detail).toContain(`requires ${manifest.engines.node}`);
    });

    it('does not pass a range it cannot read', () => {
      expect(checkNodeVersion('22.13.0', '^22').status).toBe('warn');
    });
  });

  it('reports a typed database failure as one Database row and fails the command', async () => {
    const locked = new DatabaseLockedError(join(home, '.commandvault', 'vault.db'));
    vi.mocked(createConfiguredVault).mockRejectedValue(locked);
    await writeFile(join(home, '.commandvault', 'vault.db'), '');

    await expect(runDoctor()).rejects.toThrow('1 required check failed');
    const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Report;

    const rows = report.checks.filter((row) => row.status === 'fail');
    expect(rows.map((row) => row.name)).toEqual(['Database']);
    expect(rows[0]?.detail).toBe(locked.message);
    expect(report.checks.some((row) => row.name === 'Vault scan')).toBe(false);
  });

  it('reports an untyped scan failure as a failing Vault scan row', async () => {
    vi.mocked(createConfiguredVault).mockRejectedValue(new Error('boom'));

    await expect(runDoctor()).rejects.toThrow('1 required check failed');
    const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Report;

    expect(rowNamed(report, 'Vault scan')).toMatchObject({ status: 'fail' });
    expect(rowNamed(report, 'Vault scan').detail).toContain('boom');
  });

  it('counts warnings and lists only the errors', async () => {
    const problems: ParseError[] = [
      { filePath: '/a/SKILL.md', message: 'frontmatter recovered', severity: 'warning' },
      { filePath: '/b/SKILL.md', message: 'file too large', severity: 'warning' },
      { filePath: '/c/agent.md', message: 'cannot read', severity: 'error' },
      { filePath: '/d/legacy.md', message: 'no severity means error' },
    ];
    vi.mocked(createConfiguredVault).mockResolvedValue(fakeVault(3, problems) as never);

    const report = await runDoctor();

    expect(rowNamed(report, 'Parse problems')).toMatchObject({
      status: 'warn',
      detail: '2 errors in 2 files, 2 warnings',
    });
    expect(report.problems.map((problem) => problem.filePath)).toEqual([
      '/c/agent.md',
      '/d/legacy.md',
    ]);
    expect(report.counts['fail']).toBe(0);
  });

  it('shows warnings alone as information, not as a problem', async () => {
    const warning: ParseError = { filePath: '/a', message: 'recovered', severity: 'warning' };
    vi.mocked(createConfiguredVault).mockResolvedValue(fakeVault(3, [warning]) as never);

    const report = await runDoctor();

    expect(rowNamed(report, 'Parse problems')).toMatchObject({
      status: 'info',
      detail: '1 warning',
    });
  });

  it('does not count a missing optional source as a parse problem', async () => {
    const absent: ParseError = {
      filePath: join(claudeDir, 'commands'),
      message: 'Commands directory not found',
      severity: 'error',
    };
    vi.mocked(createConfiguredVault).mockResolvedValue(fakeVault(3, [absent]) as never);

    const report = await runDoctor();

    expect(rowNamed(report, 'Parse problems')).toMatchObject({ status: 'pass', detail: 'none' });
    expect(report.problems).toEqual([]);
  });

  it('keeps a parse error for a source that does exist', async () => {
    await mkdir(join(claudeDir, 'commands'));
    const broken: ParseError = {
      filePath: join(claudeDir, 'commands'),
      message: 'cannot be read',
      severity: 'error',
    };
    vi.mocked(createConfiguredVault).mockResolvedValue(fakeVault(3, [broken]) as never);

    const report = await runDoctor();

    expect(report.problems).toHaveLength(1);
  });

  it('warns, without failing, when the scan finds no entries', async () => {
    vi.mocked(createConfiguredVault).mockResolvedValue(fakeVault(0) as never);

    const report = await runDoctor();

    expect(rowNamed(report, 'Entries')).toMatchObject({ status: 'warn' });
    expect(rowNamed(report, 'Entries').detail).toContain(claudeDir);
    expect(report.counts['fail']).toBe(0);
  });

  describe('the settings.json check', () => {
    const settingsRow = async (): Promise<Row> => rowNamed(await runDoctor(), 'settings.json');

    it('is informational when the file does not exist', async () => {
      expect(await settingsRow()).toMatchObject({ status: 'info' });
    });

    it('passes a valid object, with or without a hooks section', async () => {
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: {} }));
      expect((await settingsRow()).detail).not.toContain('no hooks');

      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'x' }));
      expect(await settingsRow()).toMatchObject({ status: 'pass' });
      expect((await settingsRow()).detail).toContain('no hooks section');
    });

    it('fails on JSON that does not parse, naming the parse error', async () => {
      await writeFile(join(claudeDir, 'settings.json'), '{ "hooks": ');

      await expect(runDoctor()).rejects.toThrow('1 required check failed');
      const row = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).checks.find(
        (candidate: Row) => candidate.name === 'settings.json',
      ) as Row;

      expect(row.status).toBe('fail');
      expect(row.detail).toMatch(/is not valid JSON: .*JSON/);
    });

    it.each(['[1, 2]', 'null', '"text"', '7'])(
      'fails on valid JSON that is not an object: %s',
      async (text) => {
        await writeFile(join(claudeDir, 'settings.json'), text);

        await expect(runDoctor()).rejects.toThrow('1 required check failed');
      },
    );
  });

  it('warns, without failing, about an installed_plugins.json that is not valid JSON', async () => {
    await mkdir(join(claudeDir, 'plugins'));
    await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), '{broken');

    const report = await runDoctor();

    expect(rowNamed(report, 'installed_plugins.json')).toMatchObject({ status: 'warn' });
    expect(report.counts['fail']).toBe(0);
  });

  it('fails the required Claude directory check when it does not exist', async () => {
    await rm(claudeDir, { recursive: true });

    await expect(runDoctor()).rejects.toThrow('1 required check failed');
  });

  it('inspects --claude-path, not the default directory', async () => {
    const elsewhere = join(home, 'elsewhere');
    await mkdir(join(elsewhere, 'skills', 'one'), { recursive: true });

    const report = await runDoctor('--claude-path', elsewhere);

    expect(report.claudeDir).toBe(elsewhere);
    expect(rowNamed(report, 'skills directory').detail).toContain(join(elsewhere, 'skills'));
    expect(rowNamed(report, 'skills directory').detail).toContain('1 skill');
  });

  it('inspects the vault with the config it already loaded, not a second read', async () => {
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(
      join(home, '.commandvault', 'config.json'),
      JSON.stringify({ claudeConfigPath: elsewhere }),
    );

    await runDoctor();

    const call = vi.mocked(createConfiguredVault).mock.calls[0];
    expect(call?.[1]).toBe(false);
    expect(call?.[2]?.config).toEqual({ claudeConfigPath: elsewhere });
  });

  it('scans against a throwaway index while no vault.db exists', async () => {
    await runDoctor();

    const overrides = vi.mocked(createConfiguredVault).mock.calls[0]?.[2];
    expect(overrides?.dbPath).toBeDefined();
    expect(overrides?.dbPath).not.toContain(join(home, '.commandvault'));
  });

  describe('when vault.db already exists', () => {
    const realDb = () => join(home, '.commandvault', 'vault.db');

    it('scans a copy of it, never the file itself', async () => {
      await writeFile(realDb(), 'the user index');
      let copied = '';
      vi.mocked(createConfiguredVault).mockImplementation((async (
        _options: unknown,
        _watch: unknown,
        overrides: { dbPath: string },
      ) => {
        copied = readFileSync(overrides.dbPath, 'utf-8');
        return {
          initialize: async () => {
            await writeFile(overrides.dbPath, 'rewritten by the scan');
            return { totalEntries: 3 };
          },
          getErrors: () => [],
          dispose: async () => undefined,
        };
      }) as never);

      const report = await runDoctor();

      expect(copied).toBe('the user index');
      expect(readFileSync(realDb(), 'utf-8')).toBe('the user index');
      expect(rowNamed(report, 'Database').status).toBe('pass');
    });

    it('fails the Database row, and leaves the file alone, when the scan had to quarantine it', async () => {
      await writeFile(realDb(), 'not sqlite');
      vi.mocked(createConfiguredVault).mockImplementation((async (
        _options: unknown,
        _watch: unknown,
        overrides: { dbPath: string },
      ) => ({
        initialize: async () => {
          await writeFile(`${overrides.dbPath}.corrupt.1791224063137.bak`, 'not sqlite');
          return { totalEntries: 3 };
        },
        getErrors: () => [],
        dispose: async () => undefined,
      })) as never);

      await expect(runDoctor()).rejects.toThrow('1 required check failed');
      const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Report;

      expect(rowNamed(report, 'Database')).toMatchObject({ status: 'fail' });
      expect(rowNamed(report, 'Database').detail).toContain(realDb());
      expect(readFileSync(realDb(), 'utf-8')).toBe('not sqlite');
    });

    it('names the real file, not the scratch copy, in a typed open error', async () => {
      await writeFile(realDb(), '');
      let scratchDb = '';
      vi.mocked(createConfiguredVault).mockImplementation((async (
        _options: unknown,
        _watch: unknown,
        overrides: { dbPath: string },
      ) => ({
        initialize: async () => {
          scratchDb = overrides.dbPath;
          throw new DatabaseIoError(overrides.dbPath, new Error('boom'));
        },
        getErrors: () => [],
        dispose: async () => undefined,
      })) as never);

      await expect(runDoctor()).rejects.toThrow('1 required check failed');
      const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Report;

      expect(rowNamed(report, 'Database').detail).toContain(realDb());
      expect(scratchDb).not.toBe('');
      expect(rowNamed(report, 'Database').detail).not.toContain(scratchDb);
    });
  });

  it('fails the config.json check, and skips the scan, when config.json is malformed', async () => {
    await writeFile(join(home, '.commandvault', 'config.json'), '{ nope');

    await expect(runDoctor()).rejects.toThrow('1 required check failed');
    const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Report;

    expect(rowNamed(report, 'config.json')).toMatchObject({ status: 'fail' });
    expect(createConfiguredVault).not.toHaveBeenCalled();
  });
});
