import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  CLI,
  FIXTURE_ENTRY_NAMES,
  IS_WINDOWS,
  context,
  createSandbox,
  entriesOf,
  expectSuccess,
  parseJson,
  type RunResult,
  type Sandbox,
} from './harness.js';
// Real SQLite files are built with core's fixtures; the compiled copy is what `turbo run test` has.
import {
  createLegacyDatabase,
  withDatabase,
  withReadonlyDatabase,
} from '../../../../core/dist/__tests__/migration-fixtures.js';

/**
 * `vault backup` and `vault restore` over the BUILT binary in a sandboxed HOME: the copy is
 * described, the three kinds are listed, a restore needs --yes outside a terminal, hostile files
 * under backup names are refused without touching vault.db, a real round trip brings the backed-up
 * state back and keeps the replaced state as a pre-restore copy, and the private modes come back.
 */

vi.setConfig({ testTimeout: 60_000 });

const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const MANUAL_NAME = /vault-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db/;
const TRUNCATED_BYTES = 2000;
const NEWER_VERSION = 99;
const PARALLEL_BACKUPS = 4;

let box: Sandbox;
let dbPath: string;
let backupDir: string;

beforeAll(() => {
  box = createSandbox();
  dbPath = join(box.dataDir, 'vault.db');
  backupDir = join(box.dataDir, 'backups');
  expectSuccess(box.run(['list']));
});

afterAll(() => {
  box?.dispose();
});

const run = (args: readonly string[]): RunResult => box.run(args);
/** The id of a process that has already exited, so nothing holds it any more. */
const deadProcessId = (): number => spawnSync(process.execPath, ['-e', '']).pid;

/** Starts the CLI without waiting, so several copies of it can run at the same time. */
function runInBackground(sandbox: Sandbox, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: sandbox.workDir,
      env: sandbox.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) =>
      resolve({ args, status: null, stdout, stderr, error: error.message }),
    );
    child.on('close', (status) => resolve({ args, status, stdout, stderr }));
  });
}
const sha = (): string => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
const preRestores = (): string[] =>
  readdirSync(backupDir).filter((name) => name.startsWith('pre-restore-'));
const errorLines = (result: RunResult): string[] =>
  result.stderr.split('\n').filter((line) => line.startsWith('error:'));

function favoriteOf(path: string, name: string): number {
  return withReadonlyDatabase(
    path,
    (db) =>
      (db.prepare('SELECT favorite FROM entries WHERE name = ?').get(name) as { favorite: number })
        .favorite,
  );
}

function expectFailure(result: RunResult, status: number, message: RegExp): void {
  expect(result.status, context(result)).toBe(status);
  expect(result.stderr, context(result)).toMatch(message);
  expect(errorLines(result), context(result)).toHaveLength(1);
  expect(result.stdout, context(result)).toBe('');
}

describe('built CLI: backup', () => {
  it('writes a consistent copy and --json describes it', () => {
    const created = run(['backup']);
    expectSuccess(created);
    expect(created.stdout, context(created)).toMatch(/Backup created: .*vault-.*\.db/);

    const described = run(['backup', '--json']);
    expectSuccess(described);
    const document = parseJson<{ path: string; kind: string; bytes: number; pruned: number }>(
      described,
    );
    expect(document.kind).toBe('consistent');
    expect(document.pruned).toBe(0);
    expect(basename(document.path)).toMatch(MANUAL_NAME);
    expect(statSync(document.path).size).toBe(document.bytes);
  });

  it('--list shows manual copies and the pre-migrate copy a 0.1.0 database left, with size and date', () => {
    // A 0.1.0 database in place of the current one; the next command migrates it and keeps a copy.
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    createLegacyDatabase(dbPath);
    expectSuccess(run(['list']));
    const preMigrate = readdirSync(backupDir).find((name) => name.startsWith('pre-migrate-v2-'));
    expect(preMigrate).toBeDefined();

    const listed = run(['backup', '--list']);
    expectSuccess(listed);
    expect(listed.stdout, context(listed)).toMatch(/Available backups:/);
    expect(listed.stdout, context(listed)).toMatch(
      new RegExp(
        `${preMigrate}\\s+pre-migrate\\s+[\\d.]+ KB\\s+\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}`,
      ),
    );
    expect(listed.stdout, context(listed)).toMatch(/vault-.*\.db\s+manual\s+[\d.]+ KB/);

    const asJson = parseJson<{ backups: { file: string; kind: string }[] }>(
      run(['backup', '--list', '--json']),
    );
    expect(asJson.backups.map((entry) => entry.kind)).toContain('pre-migrate');
    expect(asJson.backups.map((entry) => entry.kind)).toContain('manual');
  });

  describe('in a sandbox of their own, so the copies they leave do not change what the tests below see', () => {
    let alone: Sandbox;

    beforeAll(() => {
      alone = createSandbox();
      expectSuccess(alone.run(['list']));
    });

    afterAll(() => {
      alone?.dispose();
    });

    it('lets backups started together all succeed, each under a name of its own', async () => {
      const results = await Promise.all(
        Array.from({ length: PARALLEL_BACKUPS }, () =>
          runInBackground(alone, ['backup', '--json']),
        ),
      );

      for (const result of results) expectSuccess(result);
      const paths = results.map((result) => parseJson<{ path: string }>(result).path);
      expect(new Set(paths).size).toBe(PARALLEL_BACKUPS);
      for (const path of paths) expect(existsSync(path), path).toBe(true);
    });

    it('clears the staged copy of a restore killed while it inspected, whatever backup command runs next', () => {
      const stale = join(
        alone.dataDir,
        'backups',
        `vault-2001-01-01T00-00-07.db.inspect.${deadProcessId()}.tmp`,
      );
      writeFileSync(stale, 'x'.repeat(4096));

      const listed = alone.run(['backup', '--list']);

      expectSuccess(listed);
      expect(existsSync(stale)).toBe(false);
      expect(listed.stdout, context(listed)).not.toContain('.inspect.');
    });
  });
});

describe('built CLI: restore refuses what it must', () => {
  it.each([[''], ['.'], ['..'], ['../x'], ['vault.db']])(
    'exits 2 for the argument %j with one error line and no output',
    (name) => {
      expectFailure(run(['restore', '--yes', name]), EXIT_USAGE, /only backup filenames/);
    },
  );

  it('exits 2 for a valid name without --yes when not in a terminal, naming the flag', () => {
    // Its own copy, so the test also holds on its own (`-t`), not only after the backup tests.
    const copy = basename(parseJson<{ path: string }>(run(['backup', '--json'])).path);
    expectFailure(run(['restore', copy]), EXIT_USAGE, /pass --yes/);
  });

  const hostile: ReadonlyArray<[string, string, (path: string) => void]> = [
    ['random bytes', 'vault-2001-01-01T00-00-01.db', (path) => writeFileSync(path, 'junk')],
    ['an empty file', 'vault-2001-01-01T00-00-02.db', (path) => writeFileSync(path, '')],
    [
      'a truncated database',
      'vault-2001-01-01T00-00-03.db',
      (path) => writeFileSync(path, readFileSync(dbPath).subarray(0, TRUNCATED_BYTES)),
    ],
    [
      'a database from a newer schema',
      'vault-2001-01-01T00-00-05.db',
      (path) => {
        copyFileSync(dbPath, path);
        withDatabase(path, (db) => {
          db.prepare("INSERT INTO schema_version (version, description) VALUES (?, 'x')").run(
            NEWER_VERSION,
          );
          db.exec("DELETE FROM engine_meta WHERE key = 'compatible_from'");
        });
      },
    ],
  ];

  it.each(hostile)(
    'refuses %s under a backup name, leaving vault.db untouched',
    (_what, name, write) => {
      write(join(backupDir, name));
      const before = sha();
      const pre = preRestores();

      const result = run(['restore', '--yes', name]);

      expectFailure(result, EXIT_RUNTIME, new RegExp(`^error: refusing to restore ${name}`, 'm'));
      expect(sha()).toBe(before);
      expect(preRestores()).toEqual(pre);
    },
  );

  it.skipIf(IS_WINDOWS)('refuses a symbolic link under a backup name', () => {
    const name = 'vault-2001-01-01T00-00-04.db';
    symlinkSync(dbPath, join(backupDir, name));
    const before = sha();

    const result = run(['restore', '--yes', name]);

    expectFailure(result, EXIT_RUNTIME, /^error: refusing to restore .*not a regular file/m);
    expect(sha()).toBe(before);
  });

  it('refuses a directory under a backup name', () => {
    const name = 'vault-2001-01-01T00-00-06.db';
    mkdirSync(join(backupDir, name));

    expectFailure(run(['restore', '--yes', name]), EXIT_RUNTIME, /^error: refusing to restore/m);
  });
});

describe('built CLI: restore on a machine with no database yet', () => {
  it('exits 1 "no vault database" with the `vault list` hint, and creates nothing', () => {
    const copy = parseJson<{ path: string }>(run(['backup', '--json'])).path;
    const fresh = createSandbox();
    try {
      mkdirSync(join(fresh.dataDir, 'backups'), { recursive: true });
      copyFileSync(copy, join(fresh.dataDir, 'backups', basename(copy)));

      const result = fresh.run(['restore', '--yes', basename(copy)]);

      expectFailure(result, EXIT_RUNTIME, /^error: no vault database at .*vault\.db/m);
      expect(result.stderr, context(result)).toMatch(/vault list/);
      expect(readdirSync(fresh.dataDir)).toEqual(['backups']);
    } finally {
      fresh.dispose();
    }
  });
});

describe('built CLI: a restore round trip', () => {
  it('brings the backed-up state back and keeps the replaced state as a pre-restore copy', () => {
    expectSuccess(run(['favorite', 'demo-skill']));
    expect(favoriteOf(dbPath, 'demo-skill')).toBe(1);
    const copy = basename(parseJson<{ path: string }>(run(['backup', '--json'])).path);
    expectSuccess(run(['favorite', 'demo-skill']));
    expect(favoriteOf(dbPath, 'demo-skill')).toBe(0);
    const preBefore = preRestores();

    const restored = run(['restore', '--yes', copy]);

    expectSuccess(restored);
    expect(restored.stdout, context(restored)).toMatch(
      new RegExp(`Database restored from: ${copy} \\(\\d+ entries, schema \\d+\\)`),
    );
    expect(restored.stdout, context(restored)).toContain(join(backupDir, 'pre-restore-'));
    expect(favoriteOf(dbPath, 'demo-skill')).toBe(1);
    const [added] = preRestores().filter((name) => !preBefore.includes(name));
    expect(added).toBeDefined();
    expect(favoriteOf(join(backupDir, added as string), 'demo-skill')).toBe(0);
    // The next command opens the restored file like any other.
    const names = entriesOf(run(['list', '--json'])).map((entry) => entry.name);
    expect(names.sort()).toEqual([...FIXTURE_ENTRY_NAMES].sort());
  });

  it('--json --yes prints the result as one document', () => {
    const copy = basename(parseJson<{ path: string }>(run(['backup', '--json'])).path);

    const result = run(['restore', '--json', '--yes', copy]);

    expectSuccess(result);
    const document = parseJson<{
      restored: { file: string; entries: number; schemaVersion: number };
      preRestore: string;
    }>(result);
    expect(document.restored.file).toBe(copy);
    expect(document.restored.entries).toBe(FIXTURE_ENTRY_NAMES.length);
    expect(existsSync(document.preRestore)).toBe(true);
  });
});

describe.skipIf(IS_WINDOWS)('built CLI: the private modes come back', () => {
  it('a vault command re-applies 0700 to the directories and 0600 to the files', () => {
    const [copy] = readdirSync(backupDir).filter((name) => MANUAL_NAME.test(name));
    chmodSync(box.dataDir, 0o755);
    chmodSync(dbPath, 0o644);
    chmodSync(backupDir, 0o755);
    chmodSync(join(backupDir, copy as string), 0o644);

    expectSuccess(run(['stats']));

    const modeOf = (path: string): number => statSync(path).mode & 0o777;
    expect(modeOf(box.dataDir)).toBe(0o700);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(backupDir)).toBe(0o700);
    expect(modeOf(join(backupDir, copy as string))).toBe(0o600);
  });
});
