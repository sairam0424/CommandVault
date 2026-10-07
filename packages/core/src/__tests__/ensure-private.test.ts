import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivate } from '../indexer/backup-restore.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { Vault } from '../vault.js';
import { captureStderr, makeTempDir } from './db-open-helpers.js';

/**
 * The data directory was made 0700 and vault.db 0600 only when they were created, so a
 * vault from 0.1.0 stayed world-readable (drwxr-xr-x / -rw-r--r--) through every upgrade, raw
 * entry bodies included. Every open re-applies the modes now.
 */

const chmodFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));
const readdirFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: (path: import('node:fs').PathLike, mode: import('node:fs').Mode) => {
      if (chmodFailure.code !== undefined) {
        throw Object.assign(new Error(`${chmodFailure.code}: simulated, chmod`), {
          code: chmodFailure.code,
        });
      }
      actual.chmodSync(path, mode);
    },
    readdirSync: ((path: import('node:fs').PathLike, options?: unknown) => {
      if (readdirFailure.code !== undefined) {
        throw Object.assign(new Error(`${readdirFailure.code}: simulated, scandir`), {
          code: readdirFailure.code,
        });
      }
      return (actual.readdirSync as (...args: unknown[]) => unknown)(path, options);
    }) as typeof actual.readdirSync,
  };
});

const SKIP = process.platform === 'win32' || process.getuid?.() === 0;
const WORLD_READABLE_DIR = 0o755;
const WORLD_READABLE_FILE = 0o644;
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe.skipIf(SKIP)('ensurePrivate re-applies owner-only modes', () => {
  let dir: string;
  let dbPath: string;
  let backups: string;

  beforeEach(() => {
    dir = makeTempDir('private');
    dbPath = join(dir, 'vault.db');
    backups = join(dir, 'backups');
    chmodFailure.code = undefined;
    readdirFailure.code = undefined;
  });

  afterEach(() => {
    readdirFailure.code = undefined;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedWorldReadable(): void {
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(dbPath + suffix, 'x');
    mkdirSync(backups);
    writeFileSync(join(backups, 'vault-2026-01-01T00-00-00.db'), 'x');
    for (const file of [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      join(backups, 'vault-2026-01-01T00-00-00.db'),
    ]) {
      chmodSync(file, WORLD_READABLE_FILE);
    }
    chmodSync(backups, WORLD_READABLE_DIR);
    chmodSync(dir, WORLD_READABLE_DIR);
  }

  it('turns 0755/0644 into 0700/0600 for the directory, the database, its sidecars and the backups', () => {
    seedWorldReadable();

    ensurePrivate(dbPath);

    expect(modeOf(dir)).toBe(PRIVATE_DIR);
    expect(modeOf(dbPath)).toBe(PRIVATE_FILE);
    expect(modeOf(`${dbPath}-wal`)).toBe(PRIVATE_FILE);
    expect(modeOf(`${dbPath}-shm`)).toBe(PRIVATE_FILE);
    expect(modeOf(backups)).toBe(PRIVATE_DIR);
    expect(modeOf(join(backups, 'vault-2026-01-01T00-00-00.db'))).toBe(PRIVATE_FILE);
  });

  it('leaves a symbolic link and its target alone', () => {
    const target = join(makeTempDir('private-target'), 'real.db');
    writeFileSync(target, 'x');
    chmodSync(target, WORLD_READABLE_FILE);
    symlinkSync(target, dbPath);

    ensurePrivate(dbPath);

    expect(modeOf(target)).toBe(WORLD_READABLE_FILE);
    expect(modeOf(dir)).toBe(PRIVATE_DIR);
  });

  it('does nothing, and does not throw, for a directory that does not exist', () => {
    expect(() => ensurePrivate(join(dir, 'nowhere', 'vault.db'))).not.toThrow();
  });

  it('leaves a regular file named backups alone (ENOTDIR), fixes the rest, and does not throw', () => {
    seedWorldReadable();
    rmSync(backups, { recursive: true });
    writeFileSync(backups, 'notes');
    chmodSync(backups, WORLD_READABLE_FILE);
    const stderr = captureStderr();

    expect(() => ensurePrivate(dbPath)).not.toThrow();

    expect(modeOf(dir)).toBe(PRIVATE_DIR);
    expect(modeOf(dbPath)).toBe(PRIVATE_FILE);
    expect(modeOf(backups)).toBe(WORLD_READABLE_FILE);
    expect(stderr.lines()).toEqual([]);
  });

  it('does not chmod a regular file standing where the data directory should be, and does not throw', () => {
    const file = join(dir, 'datafile');
    writeFileSync(file, '');
    chmodSync(file, WORLD_READABLE_FILE);

    expect(() => ensurePrivate(join(file, 'vault.db'))).not.toThrow();

    expect(modeOf(file)).toBe(WORLD_READABLE_FILE);
  });

  it('leaves a folder inside backups/ traversable: only the regular files there become 0600', () => {
    seedWorldReadable();
    const sub = join(backups, 'old');
    mkdirSync(sub);
    chmodSync(sub, WORLD_READABLE_DIR);

    ensurePrivate(dbPath);

    expect(modeOf(sub)).toBe(WORLD_READABLE_DIR);
    expect(modeOf(join(backups, 'vault-2026-01-01T00-00-00.db'))).toBe(PRIVATE_FILE);
  });

  it('ignores a backups folder it may not list (EACCES) without throwing or complaining', () => {
    seedWorldReadable();
    readdirFailure.code = 'EACCES';
    const stderr = captureStderr();

    expect(() => ensurePrivate(dbPath)).not.toThrow();

    expect(modeOf(dir)).toBe(PRIVATE_DIR);
    expect(modeOf(dbPath)).toBe(PRIVATE_FILE);
    expect(stderr.lines()).toEqual([]);
  });

  it('reports, on stderr, a listing failure it does not expect (EIO), and still does not throw', () => {
    seedWorldReadable();
    readdirFailure.code = 'EIO';
    const stderr = captureStderr();

    expect(() => ensurePrivate(dbPath)).not.toThrow();

    expect(stderr.lines().join('')).toMatch(/could not list .*backups: EIO/);
  });

  it('ignores a refused chmod (EPERM) without throwing', () => {
    seedWorldReadable();
    chmodFailure.code = 'EPERM';
    const stderr = captureStderr();

    expect(() => ensurePrivate(dbPath)).not.toThrow();

    expect(modeOf(dbPath)).toBe(WORLD_READABLE_FILE);
    expect(stderr.lines()).toEqual([]);
  });

  it('reports, on stderr, a chmod failure it does not expect, and still does not throw', () => {
    seedWorldReadable();
    chmodFailure.code = 'ENOTSUP';
    const stderr = captureStderr();

    expect(() => ensurePrivate(dbPath)).not.toThrow();

    expect(stderr.lines().join('')).toMatch(/could not make .* private: ENOTSUP/);
  });

  it('is applied by Vault.initialize(), so an upgrade from 0.1.0 fixes the modes', async () => {
    (await SqliteEngine.create(dbPath)).close();
    chmodSync(dbPath, WORLD_READABLE_FILE);
    chmodSync(dir, WORLD_READABLE_DIR);
    const claudeDir = makeTempDir('private-claude');
    const vault = new Vault({ claudeConfigPath: claudeDir, dbPath, enableWatcher: false });

    try {
      await vault.initialize();
    } finally {
      await vault.dispose();
    }

    expect(modeOf(dir)).toBe(PRIVATE_DIR);
    expect(modeOf(dbPath)).toBe(PRIVATE_FILE);
  });
});
