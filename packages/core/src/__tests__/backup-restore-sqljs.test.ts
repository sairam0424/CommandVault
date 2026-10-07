import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BackupRejectedError,
  backupVault,
  inspectBackup,
  restoreVault,
} from '../indexer/backup-restore.js';
import { DatabaseOpenError } from '../indexer/db-errors.js';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { captureStderr, makeTempDir, writeGarbage } from './db-open-helpers.js';
import { raceEntries, raceEntryId } from './reindex-race-support.js';
import { sha256 } from './backup-test-support.js';

/**
 * The pure-JavaScript backend (the VS Code extension) copies a database as the bytes of its file:
 * it cannot read a write-ahead log a native process filled, so such a copy would be stale and is
 * refused. Its adapter also ignores `readonly` and repairs a corrupt file in place, so
 * a backup is only ever judged on a staged copy, never where the user keeps it.
 */

vi.mock('../indexer/database-factory.js', () => ({
  createDatabaseAdapter: (path: string, options?: Record<string, unknown>) =>
    SqlJsAdapter.create(path, options),
}));

const GARBAGE_BODY_BYTES = 4000;

describe('backups and restores on the sql.js backend', () => {
  let dir: string;
  let dbPath: string;
  let scratch: string;
  let entryId: string;

  beforeEach(async () => {
    dir = makeTempDir('sqljs-backup');
    dbPath = join(dir, 'vault.db');
    scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    entryId = raceEntryId(0);
    const engine = await SqliteEngine.create(dbPath);
    try {
      engine.index(raceEntries(2));
    } finally {
      engine.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to back up while a native process holds commits in the -wal, writing nothing', async () => {
    writeFileSync(`${dbPath}-wal`, 'frames a native writer committed');
    const destination = join(dir, 'copy.db');

    const failure = await backupVault(dbPath, destination).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DatabaseOpenError);
    expect((failure as Error).message).toMatch(/write-ahead log holds changes a native/);
    expect((failure as Error).message).toMatch(/native SQLite driver/);
    expect(existsSync(destination)).toBe(false);
  });

  it('copies the file as it is when there is no -wal, and the copy is consistent', async () => {
    const destination = join(dir, 'copy.db');

    const result = await backupVault(dbPath, destination);

    expect(result.kind).toBe('consistent');
    expect(readFileSync(destination).equals(readFileSync(dbPath))).toBe(true);
  });

  it('never calls the copy of a database the adapter emptied "consistent" (it ignores readonly)', async () => {
    // The adapter repairs the live file in place on what was meant as a read, so the bytes copied
    // are those of the empty file it left, which SQLite opens and quick_check passes. Until
    // SqlJsAdapter honours `readonly` (outside this module) the honest verdict is `damaged`; once
    // it does, the open fails and the copy becomes `raw`. Neither is `consistent`.
    writeGarbage(dbPath);
    const destination = join(dir, 'copy.db');
    captureStderr();

    const result = await backupVault(dbPath, destination);

    expect(result.kind).not.toBe('consistent');
    expect(result.warning).toMatch(/vault restore will refuse it/);
    expect(existsSync(destination)).toBe(true);
  });

  it('judges a corrupt backup on the staged copy: the original is intact and the litter is gone', async () => {
    const backup = join(dir, 'vault-2026-01-01T00-00-00.db');
    // A SQLite header on random bytes passes the header check and fails inside the engine.
    writeFileSync(
      backup,
      Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(GARBAGE_BODY_BYTES)]),
    );
    const before = sha256(backup);
    const stderr = captureStderr();

    const failure = await inspectBackup(backup, scratch).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BackupRejectedError);
    expect((failure as BackupRejectedError).reason).toBe('corrupt');
    expect(sha256(backup)).toBe(before);
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt.'))).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    // The adapter's repair notice names the scratch copy, never the user's file.
    for (const line of stderr.lines()) expect(line).not.toContain(backup);
  });

  it('restores from a copy taken on this backend', async () => {
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    const backup = join(backups, 'vault-2026-01-01T00-00-00.db');
    await backupVault(dbPath, backup);
    const engine = await SqliteEngine.create(dbPath);
    try {
      engine.incrementUsage(entryId);
    } finally {
      engine.close();
    }

    const result = await restoreVault(dbPath, backup);

    expect(result.info.entries).toBe(2);
    expect(existsSync(result.preRestore)).toBe(true);
    const restored = await SqliteEngine.create(dbPath);
    try {
      expect(restored.getEntry(entryId)?.usageCount).toBe(0);
    } finally {
      restored.close();
    }
  });
});
