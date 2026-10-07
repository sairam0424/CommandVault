import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

/**
 * `vault restore` with core and the prompt mocked: the name rule, the order (not found, unknown
 * name, inspection, then the prompt, then the restore), the TTY gate behind --yes, and how the
 * typed core errors reach the user. What a restore does to the files is core's business, see
 * core's restore-vault test.
 */

const core = vi.hoisted(() => ({
  inspectBackup: vi.fn(),
  restoreVault: vi.fn(),
  ensurePrivate: vi.fn(),
}));
const prompts = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  inspectBackup: core.inspectBackup,
  restoreVault: core.restoreVault,
  ensurePrivate: core.ensurePrivate,
}));
vi.mock('@inquirer/prompts', () => ({ confirm: prompts.confirm }));

import { BackupRejectedError, DatabaseLockedError } from '@commandvault/core';
import { createRestoreCommand } from '../../commands/restore.js';

const BACKUP = 'vault-2026-01-01T00-00-00.db';
const PRE_RESTORE = 'pre-restore-20260102T000000000Z.db';
const INFO = { schemaVersion: 5, entries: 6, bytes: 90112, journalMode: 'delete' as const };

/** The id of a process that has already exited, so nothing holds it any more. */
const deadProcessId = (): number => spawnSync(process.execPath, ['-e', '']).pid;

function buildProgram(): Command {
  const program = new Command();
  program.option('--json', 'JSON output');
  program.addCommand(createRestoreCommand());
  return program;
}

const run = (...args: string[]): Promise<Command> =>
  buildProgram().parseAsync(['node', 'vault', 'restore', ...args]);

/** Runs `fn` with stdin and stdout looking like a terminal, the way an interactive shell has them. */
async function inTerminal(fn: () => Promise<void>): Promise<void> {
  const streams = [process.stdin, process.stdout] as const;
  const previous = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  for (const stream of streams) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
  try {
    await fn();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = previous[index];
      if (descriptor === undefined) delete (stream as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(stream, 'isTTY', descriptor);
    });
  }
}

describe('restore command', () => {
  let dataDir: string;
  let backupDir: string;
  let dbPath: string;
  let previousHome: string | undefined;
  let stdout: ReturnType<typeof vi.spyOn>;

  const printed = (): string => stdout.mock.calls.map((call) => String(call[0])).join('\n');

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cv-restore-cmd-'));
    backupDir = join(dataDir, 'backups');
    dbPath = join(dataDir, 'vault.db');
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, BACKUP), 'a backup');
    writeFileSync(dbPath, 'the live database');
    previousHome = process.env['COMMANDVAULT_HOME'];
    process.env['COMMANDVAULT_HOME'] = dataDir;
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    core.inspectBackup.mockResolvedValue(INFO);
    core.restoreVault.mockResolvedValue({ preRestore: join(backupDir, PRE_RESTORE), info: INFO });
    prompts.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env['COMMANDVAULT_HOME'] = previousHome;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(['', '.', '..', '../x', 'a/b', 'vault.db', 'vault.db-wal'])(
    'exits 2 for %j before touching the file system',
    async (name) => {
      await expect(run('--yes', name)).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringMatching(/only backup filenames are allowed/),
      });
      expect(core.inspectBackup).not.toHaveBeenCalled();
      expect(core.restoreVault).not.toHaveBeenCalled();
    },
  );

  it("removes the staged copy of a restore killed while it inspected, and keeps a live process's", async () => {
    const stale = join(backupDir, `${BACKUP}.inspect.${deadProcessId()}.tmp`);
    const live = join(backupDir, `${BACKUP}.inspect.${process.ppid}.tmp`);
    writeFileSync(stale, 'x'.repeat(2048));
    writeFileSync(live, 'in use by another process');

    await run('--yes', BACKUP);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(core.restoreVault).toHaveBeenCalledTimes(1);
  });

  it('exits 1 "backup file not found" for a name that is not there', async () => {
    await expect(run('--yes', 'no-such-backup.db')).rejects.toMatchObject({
      exitCode: 1,
      message: `backup file not found: ${join(backupDir, 'no-such-backup.db')}`,
    });
    expect(core.inspectBackup).not.toHaveBeenCalled();
  });

  it('refuses a file that is there under a name CommandVault never writes', async () => {
    writeFileSync(join(backupDir, 'notes.db'), 'x');

    await expect(run('--yes', 'notes.db')).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(
        /^refusing to restore notes\.db: not a backup CommandVault wrote/,
      ),
    });
    expect(core.inspectBackup).not.toHaveBeenCalled();
  });

  it('exits 1 "no vault database" with a hint, before the prompt, when vault.db does not exist yet', async () => {
    rmSync(dbPath);

    await inTerminal(async () => {
      await expect(run(BACKUP)).rejects.toMatchObject({
        exitCode: 1,
        message: `no vault database at ${dbPath}`,
        hint: expect.stringMatching(/vault list/),
      });
    });

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(core.restoreVault).not.toHaveBeenCalled();
  });

  it('refuses before the prompt when the inspection rejects the backup', async () => {
    core.inspectBackup.mockRejectedValue(
      new BackupRejectedError(join(backupDir, BACKUP), 'corrupt', 'SQLite reports it is damaged'),
    );

    await inTerminal(async () => {
      await expect(run(BACKUP)).rejects.toMatchObject({
        exitCode: 1,
        message: `refusing to restore ${BACKUP}: SQLite reports it is damaged`,
        hint: expect.stringMatching(/damaged/),
      });
    });

    expect(core.ensurePrivate).toHaveBeenCalledWith(dbPath);
    expect(core.inspectBackup).toHaveBeenCalledWith(join(backupDir, BACKUP), backupDir);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(core.restoreVault).not.toHaveBeenCalled();
  });

  it('exits 2 without --yes when stdin or stdout is not a terminal', async () => {
    await expect(run(BACKUP)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/pass --yes to confirm when not running in a terminal/),
    });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(core.restoreVault).not.toHaveBeenCalled();
  });

  it('exits 2 without --yes under --json, even in a terminal', async () => {
    await inTerminal(async () => {
      await expect(run('--json', BACKUP)).rejects.toMatchObject({ exitCode: 2 });
    });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(core.restoreVault).not.toHaveBeenCalled();
  });

  it('--yes skips the prompt, restores and names the pre-restore copy', async () => {
    await run('--yes', BACKUP);

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(core.restoreVault).toHaveBeenCalledWith(dbPath, join(backupDir, BACKUP));
    expect(printed()).toContain(`Database restored from: ${BACKUP} (6 entries, schema 5)`);
    expect(printed()).toContain(join(backupDir, PRE_RESTORE));
  });

  it('asks in a terminal, with the counts and the warning, and stops with exit 1 on no', async () => {
    prompts.confirm.mockResolvedValue(false);

    await inTerminal(async () => {
      await expect(run(BACKUP)).rejects.toMatchObject({
        exitCode: 1,
        message: 'restore cancelled',
      });
    });

    const [question] = prompts.confirm.mock.calls[0] as [{ message: string; default: boolean }];
    expect(question.default).toBe(false);
    expect(question.message).toContain(`Replace ${dbPath} with ${BACKUP} (6 entries, schema 5)`);
    expect(question.message).toContain('Close VS Code and `vault watch` first');
    expect(core.restoreVault).not.toHaveBeenCalled();
  });

  it('asks in a terminal and restores on yes', async () => {
    await inTerminal(async () => {
      await run(BACKUP);
    });

    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(core.restoreVault).toHaveBeenCalledTimes(1);
  });

  it('--json --yes prints the restored counts and the pre-restore path as one document', async () => {
    await run('--json', '--yes', BACKUP);

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(printed())).toEqual({
      restored: { file: BACKUP, entries: 6, schemaVersion: 5 },
      preRestore: join(backupDir, PRE_RESTORE),
    });
  });

  it('passes a typed lock error through with its hint, exit 1', async () => {
    core.restoreVault.mockRejectedValue(
      new DatabaseLockedError(
        dbPath,
        new Error('another CommandVault process is reading the database'),
      ),
    );

    await expect(run('--yes', BACKUP)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/^Cannot open .*locked by another process/),
      hint: expect.stringMatching(/close other CommandVault processes/),
    });
  });

  it('reports any other failure as "restore failed: <message>", exit 1', async () => {
    core.restoreVault.mockRejectedValue(new Error('ENOSPC: no space left on device'));

    await expect(run('--yes', BACKUP)).rejects.toMatchObject({
      exitCode: 1,
      message: 'restore failed: ENOSPC: no space left on device',
    });
  });
});
