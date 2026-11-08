import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BackupRejectedError,
  inspectBackup,
  sweepStaleInspectCopies,
  type BackupRejectReason,
} from '../indexer/backup-restore.js';
import { KNOWN_SCHEMA_VERSION } from '../indexer/migrations.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { deadProcessId, makeTempDir, writeGarbage } from './db-open-helpers.js';
import {
  SAMPLE_ENTRY_COUNT,
  createBaseHealthyDatabase,
  createLegacyDatabase,
  withDatabase,
} from './migration-fixtures.js';
import { raceEntries } from './reindex-race-support.js';
import { sha256 } from './backup-test-support.js';

/**
 * `vault restore` used to install whatever file carried a backup name: text, an empty file, a
 * truncated database, a symlink to /etc/hosts, a file from a newer build. The next command then
 * quarantined it and started empty. Every backup is judged first, on a private copy, so that the
 * sql.js adapter's in-place repair of a corrupt file never touches the user's backup.
 */

const IS_WINDOWS = process.platform === 'win32';
const NEWER_VERSION = 99;
const TRUNCATED_BYTES = 2000;
const ENTRY_COUNT = 2;

describe('inspectBackup judges a backup without opening it in place', () => {
  let dir: string;
  let scratch: string;
  let backup: string;

  beforeEach(() => {
    dir = makeTempDir('inspect');
    scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    backup = join(dir, 'backups', 'vault-2026-01-01T00-00-00.db');
    mkdirSync(dirname(backup));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function migratedDatabase(path: string): Promise<void> {
    const engine = await SqliteEngine.create(path);
    try {
      engine.index(raceEntries(ENTRY_COUNT));
    } finally {
      engine.close();
    }
  }

  /** The refusal, with the proof that nothing was touched: the file, its folder, the scratch dir. */
  async function expectRefusal(path: string, reason: BackupRejectReason): Promise<void> {
    const folder = readdirSync(dirname(path)).sort();
    const before = readFileSync(path, { flag: 'r' });

    const failure = await inspectBackup(path, scratch).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BackupRejectedError);
    expect((failure as BackupRejectedError).reason).toBe(reason);
    expect((failure as BackupRejectedError).backupPath).toBe(path);
    expect((failure as BackupRejectedError).message).toContain('Refusing to restore');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dirname(path)).sort()).toEqual(folder);
    expect(readdirSync(scratch)).toEqual([]);
  }

  it('refuses random bytes as not-sqlite', async () => {
    writeGarbage(backup);
    await expectRefusal(backup, 'not-sqlite');
  });

  it('refuses a 0-byte file as not-sqlite (SQLite itself would open it as an empty database)', async () => {
    writeFileSync(backup, '');
    await expectRefusal(backup, 'not-sqlite');
  });

  it(`refuses the first ${TRUNCATED_BYTES} bytes of a real database as corrupt`, async () => {
    await migratedDatabase(join(dir, 'vault.db'));
    writeFileSync(backup, readFileSync(join(dir, 'vault.db')).subarray(0, TRUNCATED_BYTES));
    await expectRefusal(backup, 'corrupt');
  });

  it('refuses a database whose entries table is gone as missing-tables', async () => {
    await migratedDatabase(backup);
    withDatabase(backup, (db) => db.exec('DROP TABLE entries'));
    await expectRefusal(backup, 'missing-tables');
  });

  it('refuses a database whose schema_version table is gone as missing-tables', async () => {
    await migratedDatabase(backup);
    withDatabase(backup, (db) => db.exec('DROP TABLE schema_version'));
    await expectRefusal(backup, 'missing-tables');
  });

  it(`refuses schema ${NEWER_VERSION} without a compatibility floor as newer-schema`, async () => {
    await migratedDatabase(backup);
    withDatabase(backup, (db) => {
      db.prepare("INSERT INTO schema_version (version, description) VALUES (?, 'future')").run(
        NEWER_VERSION,
      );
      db.exec("DELETE FROM engine_meta WHERE key = 'compatible_from'");
    });
    await expectRefusal(backup, 'newer-schema');
  });

  it(`accepts schema ${NEWER_VERSION} when the writer declared compatible_from ${KNOWN_SCHEMA_VERSION}, as the engine does`, async () => {
    await migratedDatabase(backup);
    withDatabase(backup, (db) =>
      db
        .prepare("INSERT INTO schema_version (version, description) VALUES (?, 'future')")
        .run(NEWER_VERSION),
    );

    const info = await inspectBackup(backup, scratch);

    expect(info.schemaVersion).toBe(NEWER_VERSION);
    expect(info.entries).toBe(ENTRY_COUNT);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it.skipIf(IS_WINDOWS)('refuses a symbolic link to a valid database as not-a-file', async () => {
    const target = join(dir, 'real.db');
    await migratedDatabase(target);
    symlinkSync(target, backup);
    const targetSha = sha256(target);

    const failure = await inspectBackup(backup, scratch).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BackupRejectedError);
    expect((failure as BackupRejectedError).reason).toBe('not-a-file');
    expect(sha256(target)).toBe(targetSha);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('refuses a directory as not-a-file', async () => {
    mkdirSync(backup);
    const failure = await inspectBackup(backup, scratch).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BackupRejectedError);
    expect((failure as BackupRejectedError).reason).toBe('not-a-file');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('throws ENOENT for a missing file, which is the caller\'s "not found"', async () => {
    await expect(inspectBackup(backup, scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('describes a 0.1.0 database (schema 2) with its entry count and journal mode', async () => {
    createLegacyDatabase(backup);
    const before = sha256(backup);

    const info = await inspectBackup(backup, scratch);

    expect(info).toMatchObject({
      schemaVersion: 2,
      entries: SAMPLE_ENTRY_COUNT,
      journalMode: 'delete',
    });
    expect(info.bytes).toBe(readFileSync(backup).length);
    expect(sha256(backup)).toBe(before);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('describes the pre-migrate copy a real open wrote, at the version it was taken from', async () => {
    const dbPath = join(dir, 'vault.db');
    createBaseHealthyDatabase(dbPath);
    (await SqliteEngine.create(dbPath)).close();
    const [preMigrate] = readdirSync(join(dir, 'backups')).filter((name) =>
      name.startsWith('pre-migrate-v4-'),
    );
    expect(preMigrate).toBeDefined();

    const info = await inspectBackup(join(dir, 'backups', preMigrate!), scratch);

    expect(info).toMatchObject({ schemaVersion: 4, entries: SAMPLE_ENTRY_COUNT });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('reports write-ahead logging for a file the engine left in that mode', async () => {
    const dbPath = join(dir, 'vault.db');
    await migratedDatabase(dbPath);
    copyFileSync(dbPath, backup);

    const info = await inspectBackup(backup, scratch);

    expect(info).toMatchObject({
      schemaVersion: KNOWN_SCHEMA_VERSION,
      entries: ENTRY_COUNT,
      journalMode: 'wal',
    });
    expect(readdirSync(dirname(backup))).toEqual(['vault-2026-01-01T00-00-00.db']);
  });
});

describe('sweepStaleInspectCopies clears what a killed restore left while it inspected', () => {
  const BACKUP_NAME = 'vault-2026-01-01T00-00-00.db';
  // A live process other than this one, standing for another CommandVault process.
  const otherProcessId = process.ppid;
  let folder: string;

  beforeEach(() => {
    folder = makeTempDir('inspect-sweep');
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const copyOf = (pid: number): string => `${BACKUP_NAME}.inspect.${pid}.tmp`;
  const seed = (...names: string[]): void => {
    for (const name of names) writeFileSync(join(folder, name), 'x'.repeat(2048));
  };

  it('removes the staged copy of a process that is gone, with its sidecars and repair litter', () => {
    const stale = copyOf(deadProcessId());
    seed(
      stale,
      `${stale}-wal`,
      `${stale}-shm`,
      `${stale}-journal`,
      `${stale}.corrupt.1767225600000.bak`,
    );

    sweepStaleInspectCopies(folder);

    expect(readdirSync(folder)).toEqual([]);
  });

  it('keeps the copy of a live process, this one included, and every file that is no staged copy', () => {
    const kept = [
      copyOf(otherProcessId),
      copyOf(process.pid),
      BACKUP_NAME,
      `${BACKUP_NAME}-wal`,
      'pre-restore-20260102T000000000Z.db',
      'notes.txt',
      `${BACKUP_NAME}.inspect.notapid.tmp`,
      `${BACKUP_NAME}.inspect.${deadProcessId()}.txt`,
    ];
    seed(...kept);

    sweepStaleInspectCopies(folder);

    expect(readdirSync(folder).sort()).toEqual([...kept].sort());
  });

  it('removes only the stale copies when both kinds are there', () => {
    const stale = copyOf(deadProcessId());
    seed(stale, copyOf(otherProcessId), BACKUP_NAME);

    sweepStaleInspectCopies(folder);

    expect(readdirSync(folder).sort()).toEqual([copyOf(otherProcessId), BACKUP_NAME].sort());
  });

  it('recognizes the name inspectBackup gives its own copy', async () => {
    // Staging is synchronous, so the copy is on disk before inspectBackup first yields.
    const header = Buffer.alloc(256);
    header.write('SQLite format 3\0', 0, 'latin1');
    writeFileSync(join(folder, BACKUP_NAME), header);
    const pending = inspectBackup(join(folder, BACKUP_NAME), folder).catch(() => undefined);
    const own = readdirSync(folder).find((name) => name.includes('.inspect.'));
    expect(own).toBe(copyOf(process.pid));
    await pending;
    const stale = own!.replace(`.${process.pid}.tmp`, `.${deadProcessId()}.tmp`);
    expect(stale).not.toBe(own);
    seed(stale);

    sweepStaleInspectCopies(folder);

    expect(readdirSync(folder)).toEqual([BACKUP_NAME]);
  });

  it('does nothing, and does not throw, when the folder is missing or is a file', () => {
    expect(() => sweepStaleInspectCopies(join(folder, 'missing'))).not.toThrow();
    seed('a-file');
    expect(() => sweepStaleInspectCopies(join(folder, 'a-file'))).not.toThrow();
    expect(readdirSync(folder)).toEqual(['a-file']);
  });
});
