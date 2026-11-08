import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupVault } from '../indexer/backup-restore.js';
import { DatabaseOpenError } from '../indexer/db-errors.js';
import { makeTempDir, writeGarbage } from './db-open-helpers.js';
import { corruptTablePage, createBaseHealthyDatabase } from './migration-fixtures.js';
import { sha256 } from './backup-test-support.js';

/**
 * A damaged vault used to be copied silently with exit 0, and the user
 * learnt about it when `restore` installed it. The adapter's VACUUM INTO falls back to a
 * page-for-page copy on SQLITE_CORRUPT without telling anyone, so the copy is judged afterwards
 * and the result says what the user has.
 */

const IS_WINDOWS = process.platform === 'win32';
const OWNER_ONLY = 0o600;

describe('backupVault of a database that is not healthy', () => {
  let dir: string;
  let dbPath: string;
  let destination: string;

  beforeEach(() => {
    dir = makeTempDir('backup-damaged');
    dbPath = join(dir, 'vault.db');
    destination = join(dir, 'copy.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies a database with a damaged page as `damaged`, naming what quick_check found', async () => {
    createBaseHealthyDatabase(dbPath);
    corruptTablePage(dbPath, 'entries_fts_data');
    const before = sha256(dbPath);

    const result = await backupVault(dbPath, destination);

    expect(result.kind).toBe('damaged');
    expect(result.warning).toMatch(/Page \d+|malformed|corrupt/i);
    expect(result.warning).toMatch(/vault restore will refuse it/);
    expect(existsSync(destination)).toBe(true);
    expect(result.bytes).toBe(statSync(destination).size);
    expect(sha256(dbPath)).toBe(before);
  });

  it('copies a file SQLite cannot open as `raw`, with its -wal and -shm, owner-only', async () => {
    const garbage = writeGarbage(dbPath);
    writeFileSync(`${dbPath}-wal`, 'hot wal frames');
    writeFileSync(`${dbPath}-shm`, 'wal index');

    const result = await backupVault(dbPath, destination);

    expect(result.kind).toBe('raw');
    expect(result.warning).toMatch(/copied as is; SQLite reports .*SQLITE_NOTADB/);
    expect(result.bytes).toBe(garbage.length);
    expect(readFileSync(destination)).toEqual(garbage);
    expect(readFileSync(`${destination}-wal`, 'utf8')).toBe('hot wal frames');
    // The read-only probe rebuilds the wal-index in the -shm, so its bytes are SQLite's, not ours.
    expect(existsSync(`${destination}-shm`)).toBe(true);
    if (!IS_WINDOWS) {
      for (const suffix of ['', '-wal', '-shm']) {
        expect(statSync(destination + suffix).mode & 0o777).toBe(OWNER_ONLY);
      }
    }
    // Nothing was repaired: the garbage is still the database, and no quarantine copy appeared.
    expect(readFileSync(dbPath)).toEqual(garbage);
    expect(existsSync(`${dbPath}.corrupt.${Date.now()}.bak`)).toBe(false);
  });

  it('throws ENOENT for a missing database and creates neither the copy nor the database', async () => {
    await expect(backupVault(dbPath, destination)).rejects.toMatchObject({ code: 'ENOENT' });

    // The adapter drops `readonly` for a file that does not exist and creates it.
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it('refuses a database path that is not a regular file without creating anything', async () => {
    mkdirSync(dbPath);

    await expect(backupVault(dbPath, destination)).rejects.toBeInstanceOf(DatabaseOpenError);

    expect(existsSync(destination)).toBe(false);
  });
});
