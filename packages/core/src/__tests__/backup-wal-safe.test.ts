import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupVault } from '../indexer/backup-restore.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { makeTempDir } from './db-open-helpers.js';
import { raceEntries, raceEntryId } from './reindex-race-support.js';
import {
  isWriterRunning,
  killHeldWriter,
  quickCheck,
  sha256,
  startHeldWriter,
  stopHeldWriter,
  usageOf,
  writeVersionOf,
  type HeldWriter,
} from './backup-test-support.js';

/**
 * `vault backup` used to copy the main file only. A process that keeps its connection open
 * (the VS Code extension, `vault watch`) leaves its commits in the write-ahead log until a
 * checkpoint, so the copy lacked every one of them; the same for a killed writer's hot -wal.
 * The backup has to read what SQLite would read.
 */

const IS_WINDOWS = process.platform === 'win32';
const HELD_COMMITS = 500;
const KILLED_COMMITS = 300;
const ROLLBACK_WRITE_VERSION = 1;
const OWNER_ONLY = 0o600;

describe('backupVault under a writer holding uncheckpointed commits', () => {
  let dir: string;
  let home: string;
  let dbPath: string;
  let entryId: string;
  let writer: HeldWriter | undefined;

  beforeEach(async () => {
    dir = makeTempDir('backup-wal');
    home = makeTempDir('backup-wal-home');
    dbPath = join(dir, 'vault.db');
    entryId = raceEntryId(0);
    const engine = await SqliteEngine.create(dbPath);
    try {
      engine.index(raceEntries(3));
    } finally {
      engine.close();
    }
  });

  afterEach(async () => {
    if (writer !== undefined && isWriterRunning(writer)) await killHeldWriter(writer);
    writer = undefined;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it(`VACUUM INTO over a read-only connection reads the ${HELD_COMMITS} commits a live writer holds in the -wal, where copyFile reads 0`, async () => {
    writer = await startHeldWriter(dbPath, entryId, HELD_COMMITS, home);
    expect(writer.usage).toBe(HELD_COMMITS);
    const walBytes = statSync(`${dbPath}-wal`).size;
    expect(walBytes).toBeGreaterThan(0);
    const liveSha = sha256(dbPath);

    // The control: what the old command did, and what it missed.
    const byteCopy = join(dir, 'byte-copy.db');
    copyFileSync(dbPath, byteCopy);
    expect(usageOf(byteCopy, entryId)).toBe(0);

    const destination = join(dir, 'copy.db');
    const result = await backupVault(dbPath, destination);

    expect(result.kind).toBe('consistent');
    expect(result.warning).toBeUndefined();
    expect(result.bytes).toBe(statSync(destination).size);
    expect(usageOf(destination, entryId)).toBe(HELD_COMMITS);
    expect(quickCheck(destination)).toBe('ok');
    expect(writeVersionOf(destination)).toBe(ROLLBACK_WRITE_VERSION);
    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}-shm`)).toBe(false);
    if (!IS_WINDOWS) expect(statSync(destination).mode & 0o777).toBe(OWNER_ONLY);
    // The live database is only read: its file and its log are exactly as the writer left them.
    expect(sha256(dbPath)).toBe(liveSha);
    expect(statSync(`${dbPath}-wal`).size).toBe(walBytes);

    await stopHeldWriter(writer);
    expect(usageOf(dbPath, entryId)).toBe(HELD_COMMITS);
  });

  it(`reads the ${KILLED_COMMITS} commits in the hot -wal a killed writer left behind`, async () => {
    writer = await startHeldWriter(dbPath, entryId, KILLED_COMMITS, home);
    await killHeldWriter(writer);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    expect(usageOf(dbPath, entryId)).toBe(KILLED_COMMITS);

    const destination = join(dir, 'copy.db');
    const result = await backupVault(dbPath, destination);

    expect(result.kind).toBe('consistent');
    expect(usageOf(destination, entryId)).toBe(KILLED_COMMITS);
    expect(quickCheck(destination)).toBe('ok');
    expect(writeVersionOf(destination)).toBe(ROLLBACK_WRITE_VERSION);
  });

  it('refuses to overwrite a destination that exists, and leaves it as it is', async () => {
    const destination = join(dir, 'copy.db');
    copyFileSync(dbPath, destination);
    const before = sha256(destination);

    await expect(backupVault(dbPath, destination)).rejects.toMatchObject({ code: 'EEXIST' });

    expect(sha256(destination)).toBe(before);
  });
});
