import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

/**
 * `vault backup` with core mocked: the command's own rules (no database -> nothing created, the
 * name, the warning for a damaged copy, --json, --list over the three kinds, pruning by name).
 * What the copy holds is core's business, see core's backup-wal-safe and backup-damaged tests.
 */

const core = vi.hoisted(() => ({
  backupVault: vi.fn(),
  ensurePrivate: vi.fn(),
}));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  backupVault: core.backupVault,
  ensurePrivate: core.ensurePrivate,
}));

import { createBackupCommand } from '../../commands/backup.js';

const IS_WINDOWS = process.platform === 'win32';
const MANUAL_NAME = /vault-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/;
const PRE_MIGRATE = 'pre-migrate-v4-20260102T030405678Z-123.db';
const PRE_RESTORE = 'pre-restore-20260103T030405678Z.db';
const OLD_MANUAL = 'vault-2001-01-01T00-00-00.db';

/** The id of a process that has already exited, so nothing holds it any more. */
const deadProcessId = (): number => spawnSync(process.execPath, ['-e', '']).pid;

/** Stands in for core: creates the copy exclusively, as the adapters do (EEXIST if it exists). */
function writeExclusively(_dbPath: string, destination: string): Promise<unknown> {
  writeFileSync(destination, 'copy', { flag: 'wx' });
  return Promise.resolve({ kind: 'consistent', bytes: 4 });
}

function buildProgram(): Command {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createBackupCommand());
  return program;
}

const run = (...args: string[]): Promise<Command> =>
  buildProgram().parseAsync(['node', 'vault', 'backup', ...args]);

describe('backup command', () => {
  let dataDir: string;
  let backupDir: string;
  let dbPath: string;
  let previousHome: string | undefined;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  const printed = (): string => stdout.mock.calls.map((call) => String(call[0])).join('\n');

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cv-backup-cmd-'));
    backupDir = join(dataDir, 'backups');
    dbPath = join(dataDir, 'vault.db');
    previousHome = process.env['COMMANDVAULT_HOME'];
    process.env['COMMANDVAULT_HOME'] = dataDir;
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    core.backupVault.mockImplementation(async (_dbPath: string, destination: string) => {
      writeFileSync(destination, 'copy');
      return { kind: 'consistent', bytes: 4 };
    });
  });

  afterEach(() => {
    process.env['COMMANDVAULT_HOME'] = previousHome;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('exits 1 with a hint, and creates nothing, when there is no database yet', async () => {
    await expect(run()).rejects.toMatchObject({
      message: `backup failed: no vault database at ${dbPath}`,
      exitCode: 1,
      hint: expect.stringMatching(/run `vault list` first/),
    });

    expect(existsSync(backupDir)).toBe(false);
    expect(core.backupVault).not.toHaveBeenCalled();
  });

  it('re-applies the private modes, writes vault-<stamp>.db through core and reports it', async () => {
    writeFileSync(dbPath, 'db');

    await run();

    expect(core.ensurePrivate).toHaveBeenCalledWith(dbPath);
    expect(core.backupVault).toHaveBeenCalledTimes(1);
    const [calledDb, destination] = core.backupVault.mock.calls[0] as [string, string];
    expect(calledDb).toBe(dbPath);
    expect(destination.startsWith(backupDir)).toBe(true);
    expect(destination).toMatch(MANUAL_NAME);
    expect(printed()).toContain(`Backup created: ${destination}`);
    if (!IS_WINDOWS) expect(statSync(backupDir).mode & 0o777).toBe(0o700);
  });

  it('warns on stderr for a damaged copy and still succeeds', async () => {
    writeFileSync(dbPath, 'db');
    core.backupVault.mockResolvedValue({
      kind: 'damaged',
      bytes: 4,
      warning: 'the copy keeps the damage',
    });

    await run();

    expect(stderr.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /warning: the copy keeps the damage/,
    );
    expect(printed()).toContain('Backup created');
  });

  it('--json prints one document with path, kind, bytes and pruned', async () => {
    writeFileSync(dbPath, 'db');

    await run('--json');

    expect(stdout).toHaveBeenCalledTimes(1);
    const document = JSON.parse(printed()) as {
      path: string;
      kind: string;
      bytes: number;
      pruned: number;
    };
    expect(document).toMatchObject({ kind: 'consistent', bytes: 4, pruned: 0 });
    expect(document.path).toMatch(MANUAL_NAME);
  });

  it('reports a failure of the copy as "backup failed", exit 1', async () => {
    writeFileSync(dbPath, 'db');
    core.backupVault.mockRejectedValue(new Error('disk full'));

    await expect(run()).rejects.toMatchObject({ message: 'backup failed: disk full', exitCode: 1 });
  });

  describe('names', () => {
    const PINNED_NOW = new Date('2026-03-04T05:06:07.250Z');
    const THIS_SECOND = 'vault-2026-03-04T05-06-07.db';
    const NEXT_SECONDS = [
      'vault-2026-03-04T05-06-08.db',
      'vault-2026-03-04T05-06-09.db',
      'vault-2026-03-04T05-06-10.db',
    ];

    beforeEach(() => {
      writeFileSync(dbPath, 'db');
      mkdirSync(backupDir, { recursive: true });
      core.backupVault.mockImplementation(writeExclusively);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("takes the next second's name at once when a copy of this second exists", async () => {
      writeFileSync(join(backupDir, THIS_SECOND), 'old');

      await run();

      expect(readdirSync(backupDir).sort()).toEqual([THIS_SECOND, NEXT_SECONDS[0]]);
      expect(printed()).toContain(`Backup created: ${join(backupDir, NEXT_SECONDS[0]!)}`);
    });

    it('lets four backups started in the same second all succeed, each under its own name', async () => {
      await Promise.all(Array.from({ length: 4 }, () => run('--json')));

      expect(readdirSync(backupDir).sort()).toEqual([THIS_SECOND, ...NEXT_SECONDS]);
      const paths = stdout.mock.calls.map(
        (call) => (JSON.parse(String(call[0])) as { path: string }).path,
      );
      expect(new Set(paths).size).toBe(4);
    });

    it('gives up with one "backup failed" line when no free name turns up', async () => {
      core.backupVault.mockRejectedValue(
        Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }),
      );

      await expect(run()).rejects.toMatchObject({
        exitCode: 1,
        message: expect.stringMatching(/^backup failed: no free backup name in /),
      });
      expect(core.backupVault.mock.calls.length).toBeGreaterThan(1);
      expect(core.backupVault.mock.calls.length).toBeLessThan(200);
    });

    it('does not retry a failure that is not a taken name', async () => {
      core.backupVault.mockRejectedValue(new Error('disk full'));

      await expect(run()).rejects.toMatchObject({ message: 'backup failed: disk full' });
      expect(core.backupVault).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale staged copies', () => {
    it('removes what a restore killed while it inspected left behind, on backup and on --list', async () => {
      writeFileSync(dbPath, 'db');
      mkdirSync(backupDir, { recursive: true });
      const stale = join(backupDir, `${OLD_MANUAL}.inspect.${deadProcessId()}.tmp`);
      const live = join(backupDir, `${OLD_MANUAL}.inspect.${process.ppid}.tmp`);
      writeFileSync(live, 'in use by another process');

      writeFileSync(stale, 'x'.repeat(2048));
      await run('--list');
      expect(existsSync(stale)).toBe(false);

      writeFileSync(stale, 'x'.repeat(2048));
      await run();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(live)).toBe(true);
    });

    it('does not count a removed stale copy among the "other files" that --list reports', async () => {
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, OLD_MANUAL), 'x');
      writeFileSync(join(backupDir, `${OLD_MANUAL}.inspect.${deadProcessId()}.tmp`), 'x');

      await run('--list');

      expect(printed()).toContain(OLD_MANUAL);
      expect(printed()).not.toMatch(/other file/);
    });
  });

  describe('--list', () => {
    function seedKinds(): void {
      mkdirSync(backupDir, { recursive: true });
      const files: ReadonlyArray<[string, number]> = [
        [OLD_MANUAL, 1],
        [PRE_RESTORE, 2],
        [PRE_MIGRATE, 3],
        ['notes.txt', 4],
      ];
      for (const [name, day] of files) {
        writeFileSync(join(backupDir, name), 'x'.repeat(2048 * day));
        const when = new Date(Date.UTC(2026, 0, day));
        utimesSync(join(backupDir, name), when, when);
      }
    }

    it('shows the three kinds newest first with kind, size and date, and counts other files', async () => {
      seedKinds();

      await run('--list');

      const output = printed();
      expect(output).toContain('Available backups:');
      const order = [PRE_MIGRATE, PRE_RESTORE, OLD_MANUAL].map((name) => output.indexOf(name));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(output).toMatch(
        new RegExp(`${PRE_MIGRATE}\\s+pre-migrate\\s+6\\.0 KB\\s+2026-01-03 00:00`),
      );
      expect(output).toMatch(/pre-restore\s+4\.0 KB/);
      expect(output).toMatch(/manual\s+2\.0 KB/);
      expect(output).not.toContain('notes.txt');
      expect(output).toMatch(/1 other file\(s\)/);
    });

    it('--json lists file, kind, bytes and modifiedAt for the backups only', async () => {
      seedKinds();

      await run('--list', '--json');

      const document = JSON.parse(printed()) as {
        backups: { file: string; kind: string; bytes: number; modifiedAt: string }[];
      };
      expect(document.backups.map((entry) => [entry.file, entry.kind])).toEqual([
        [PRE_MIGRATE, 'pre-migrate'],
        [PRE_RESTORE, 'pre-restore'],
        [OLD_MANUAL, 'manual'],
      ]);
      expect(document.backups[0]).toMatchObject({
        bytes: 6144,
        modifiedAt: '2026-01-03T00:00:00.000Z',
      });
    });

    it('says so when there is no backups directory, in both forms', async () => {
      await run('--list');
      expect(printed()).toContain('No backups directory found');

      stdout.mockClear();
      await run('--list', '--json');
      expect(JSON.parse(printed())).toEqual({ backups: [] });
    });

    it('treats a regular file under the backups name (ENOTDIR) as no directory, in both forms', async () => {
      writeFileSync(backupDir, 'notes');

      await run('--list');
      expect(printed()).toContain('No backups directory found');

      stdout.mockClear();
      await run('--list', '--json');
      expect(JSON.parse(printed())).toEqual({ backups: [] });
    });
  });

  it('prunes vault-*.db beyond ten by name, leaving the other kinds alone', async () => {
    writeFileSync(dbPath, 'db');
    mkdirSync(backupDir, { recursive: true });
    const seeded = Array.from(
      { length: 11 },
      (_, day) => `vault-2001-01-${String(day + 1).padStart(2, '0')}T00-00-00.db`,
    );
    for (const name of [...seeded, PRE_MIGRATE, PRE_RESTORE])
      writeFileSync(join(backupDir, name), 'old');

    await run();

    const kept = readdirSync(backupDir).sort();
    expect(kept.filter((name) => MANUAL_NAME.test(name))).toHaveLength(10);
    expect(kept).not.toContain(seeded[0]);
    expect(kept).not.toContain(seeded[1]);
    expect(kept).toContain(PRE_MIGRATE);
    expect(kept).toContain(PRE_RESTORE);
    expect(printed()).toMatch(/Pruned 2 old backup\(s\) \(keeping last 10\)/);
  });

  it("prunes the -wal and -shm of a raw copy together with it, and leaves the kept copies' alone", async () => {
    writeFileSync(dbPath, 'db');
    mkdirSync(backupDir, { recursive: true });
    const seeded = Array.from(
      { length: 11 },
      (_, day) => `vault-2001-01-${String(day + 1).padStart(2, '0')}T00-00-00.db`,
    );
    for (const name of seeded) writeFileSync(join(backupDir, name), 'old');
    const oldest = seeded[0]!;
    const kept = seeded[10]!;
    for (const name of [oldest, kept]) {
      for (const suffix of ['-wal', '-shm']) writeFileSync(join(backupDir, name + suffix), 'side');
    }

    await run();

    const left = readdirSync(backupDir);
    expect(left).not.toContain(oldest);
    expect(left).not.toContain(`${oldest}-wal`);
    expect(left).not.toContain(`${oldest}-shm`);
    expect(left).toContain(kept);
    expect(left).toContain(`${kept}-wal`);
    expect(left).toContain(`${kept}-shm`);
    expect(printed()).toMatch(/Pruned 2 old backup\(s\)/);
  });
});
