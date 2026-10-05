import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { BetterSqliteAdapter } from '../indexer/better-sqlite-adapter.js';
import {
  DatabaseCorruptError,
  DatabaseLockedError,
  DatabasePermissionError,
} from '../indexer/db-errors.js';
import {
  PAGE_SIZE,
  addUnparseableSchemaEntry,
  backupNames,
  captureStderr,
  countFavorites,
  makeTempDir,
  seedDatabase,
  seedUncheckpointedDatabase,
  snapshotDir,
  writeGarbage,
  type StderrCapture,
} from './db-open-helpers.js';

const CANNOT_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;
const SMALL_BUSY_TIMEOUT_MS = 50;
const LOCK_FAILURE_BUDGET_MS = 3000;
const LOCK_RELEASE_DELAY_MS = 120;
const SAME_MILLISECOND = 1_700_000_000_000;
const SQLITE_MAGIC_BYTES = 16;

describe('BetterSqliteAdapter open: a database is only quarantined on proof of corruption', () => {
  let dir: string;
  let dbPath: string;
  let stderr: StderrCapture;

  beforeEach(() => {
    dir = makeTempDir('open-real');
    dbPath = join(dir, 'vault.db');
    stderr = captureStderr();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function noticesNaming(backupPath: string): string[] {
    return stderr.lines().filter((line) => line.includes(backupPath));
  }

  it('keeps a healthy database and its rows, with no backup and no notice', async () => {
    seedDatabase(dbPath, { wal: true, rows: 5 });

    const adapter = await BetterSqliteAdapter.create(dbPath);
    expect(adapter.queryOne<{ c: number }>('SELECT count(*) AS c FROM favorites')?.c).toBe(5);
    adapter.close();

    expect(backupNames(dir)).toEqual([]);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it('creates a brand-new database with owner-only permissions', async () => {
    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();

    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    }
    expect(backupNames(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the file mode of a database that already exists',
    async () => {
      seedDatabase(dbPath, { wal: true, rows: 2 });
      const groupReadable = 0o640;
      chmodSync(dbPath, groupReadable);

      const adapter = await BetterSqliteAdapter.create(dbPath);
      adapter.close();

      // Only a database this open creates is made owner-only; one that exists is the user's to manage.
      expect(statSync(dbPath).mode & 0o777).toBe(groupReadable);
      expect(backupNames(dir)).toEqual([]);
    },
  );

  it('creates a new database for a read-only open of a file that does not exist yet', async () => {
    // Read-only only applies to a database that is already there; a missing one is created, as it
    // always was, so a first run with a read-only command still ends with a usable vault.
    const adapter = await BetterSqliteAdapter.create(dbPath, { readonly: true });
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.close();

    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    }
    expect(backupNames(dir)).toEqual([]);
  });

  it('saves a garbage file byte-for-byte under a backup name, announces it once, and returns a working database', async () => {
    const garbage = writeGarbage(dbPath);

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.execute('INSERT INTO fresh (id) VALUES (7)');
    expect(adapter.queryOne<{ id: number }>('SELECT id FROM fresh')?.id).toBe(7);
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(garbage)).toBe(true);
    expect(noticesNaming(join(dir, backup!))).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual([backup, 'vault.db'].sort());
  });

  it('still detects a garbage file when WAL mode is off, where no pragma would read it', async () => {
    const garbage = writeGarbage(dbPath);

    const adapter = await BetterSqliteAdapter.create(dbPath, { walMode: false });
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(garbage)).toBe(true);
  });

  it('quarantines a database truncated at a page boundary because SQLite reports it corrupt', async () => {
    seedDatabase(dbPath, { rows: 2000 });
    truncateSync(dbPath, PAGE_SIZE * 3);
    const truncatedBytes = readFileSync(dbPath);
    const probePath = join(dir, 'probe-copy');
    copyFileSync(dbPath, probePath);
    const probe = new Database(probePath);
    let evidence: unknown;
    try {
      probe.pragma('journal_mode = WAL');
    } catch (error) {
      evidence = error;
    } finally {
      probe.close();
      rmSync(probePath, { force: true });
    }
    // Record what SQLite says about this exact file: the quarantine is only legitimate because of it.
    expect((evidence as { code?: string }).code).toMatch(/^SQLITE_(CORRUPT|NOTADB)/);

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(truncatedBytes)).toBe(true);
  });

  it('saves a sidecar SQLite leaves behind and leaves none beside the fresh database', async () => {
    const garbage = writeGarbage(dbPath);
    const staleShm = randomBytes(1024);
    writeFileSync(`${dbPath}-shm`, staleShm);
    // A non-empty -wal is deleted by SQLite itself when the failed open closes, so the repair is
    // only observable through the -shm; db-quarantine.test.ts saves all three sidecars.

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();

    const [backup] = backupNames(dir);
    const backupPath = join(dir, backup!);
    expect(readFileSync(backupPath).equals(garbage)).toBe(true);
    expect(readFileSync(`${backupPath}-shm`).equals(staleShm)).toBe(true);
    // A stale -wal or -shm next to the new file would be replayed into it.
    expect(readdirSync(dir).filter((name) => name.startsWith('vault.db-'))).toEqual([]);
  });

  it('leaves a healthy database alone whose schema this SQLite cannot parse', async () => {
    // What a vault.db written by a newer SQLite looks like to an older bundled one: SQLite says
    // SQLITE_CORRUPT with a detail tail, but the file is fine and only a newer engine can read it.
    seedDatabase(dbPath, { wal: true, rows: 5 });
    addUnparseableSchemaEntry(dbPath, 'CREATE TABLE k2 (a) FROBNICATE');
    const before = snapshotDir(dir);

    const failure = await BetterSqliteAdapter.create(dbPath).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(backupNames(dir)).toEqual([]);
    expect(snapshotDir(dir)).toEqual(before);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
    // Unrecognised, so the driver's own error comes back untouched.
    expect((failure as { code?: string }).code).toBe('SQLITE_CORRUPT');
    expect((failure as Error).message).toMatch(/^malformed database schema \(k2\) - /);
  });

  it('still saves a database whose schema entry is damaged beyond parsing', async () => {
    seedDatabase(dbPath, { wal: true, rows: 5 });
    const bytes = readFileSync(dbPath);
    bytes.write('XREATE', bytes.indexOf('CREATE TABLE'));
    writeFileSync(dbPath, bytes);

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(bytes)).toBe(true);
    expect(noticesNaming(join(dir, backup!))).toHaveLength(1);
  });

  it('saves a corrupt database with a write-ahead log on the first open, with its rows recoverable', async () => {
    // Closing the failed handle makes SQLite fold the -wal into the main file and delete the
    // sidecars, which changes the file under the attempt that failed. That must not be mistaken
    // for another process having repaired it: the first run has to finish the job.
    const rows = 5;
    seedUncheckpointedDatabase(dbPath, rows);
    expect(readdirSync(dir).sort()).toEqual(['vault.db', 'vault.db-shm', 'vault.db-wal']);
    const magic = readFileSync(dbPath).subarray(0, SQLITE_MAGIC_BYTES);
    const scribbled = Buffer.alloc(SQLITE_MAGIC_BYTES, 0x41);
    const fd = openSync(dbPath, 'r+');
    writeSync(fd, scribbled, 0, SQLITE_MAGIC_BYTES, 0);
    closeSync(fd);

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(noticesNaming(join(dir, backup!))).toHaveLength(1);
    // Everything the backup holds, put back under the original names with the header repaired.
    const recovered = join(makeTempDir('open-recovered'), 'vault.db');
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const saved = join(dir, backup! + suffix);
        if (existsSync(saved)) copyFileSync(saved, recovered + suffix);
      }
      const fdRecovered = openSync(recovered, 'r+');
      writeSync(fdRecovered, magic, 0, SQLITE_MAGIC_BYTES, 0);
      closeSync(fdRecovered);
      expect(countFavorites(recovered)).toBe(rows);
    } finally {
      rmSync(dirname(recovered), { recursive: true, force: true });
    }
  });

  it('never overwrites an earlier backup when a second corruption happens', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SAME_MILLISECOND);
    const firstGarbage = writeGarbage(dbPath);
    (await BetterSqliteAdapter.create(dbPath)).close();
    const secondGarbage = writeGarbage(dbPath);
    (await BetterSqliteAdapter.create(dbPath)).close();

    const contents = backupNames(dir).map((name) => readFileSync(join(dir, name)));
    expect(contents).toHaveLength(2);
    expect(contents.some((bytes) => bytes.equals(firstGarbage))).toBe(true);
    expect(contents.some((bytes) => bytes.equals(secondGarbage))).toBe(true);
  });

  it('leaves a corrupt file in place when it was opened read-only', async () => {
    writeGarbage(dbPath);
    const before = snapshotDir(dir);

    const failure = await BetterSqliteAdapter.create(dbPath, { readonly: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(snapshotDir(dir)).toEqual(before);
    expect(failure).toBeInstanceOf(DatabaseCorruptError);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it.skipIf(CANNOT_CHMOD)(
    'reports a permission error for an unreadable file and leaves it untouched',
    async () => {
      seedDatabase(dbPath, { rows: 4 });
      const before = snapshotDir(dir);
      chmodSync(dbPath, 0o000);

      try {
        const failure = await BetterSqliteAdapter.create(dbPath).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(DatabasePermissionError);
        expect((failure as Error).message).toContain(dbPath);
        expect((failure as Error).message).toMatch(/chmod/);
      } finally {
        chmodSync(dbPath, 0o600);
      }

      expect(backupNames(dir)).toEqual([]);
      expect(snapshotDir(dir)).toEqual(before);
    },
  );

  it('retries while another connection holds the lock and opens once it is released', async () => {
    seedDatabase(dbPath, { rows: 9 });
    const holder = new Database(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    // The first attempt blocks this thread for the busy timeout; the lock is released while the
    // adapter waits between attempts.
    const release = setTimeout(() => {
      holder.exec('ROLLBACK');
      holder.close();
    }, LOCK_RELEASE_DELAY_MS);

    try {
      const adapter = await BetterSqliteAdapter.create(dbPath, {
        busyTimeout: SMALL_BUSY_TIMEOUT_MS,
      });
      expect(adapter.queryOne<{ c: number }>('SELECT count(*) AS c FROM favorites')?.c).toBe(9);
      adapter.close();
    } finally {
      clearTimeout(release);
      if (holder.open) {
        holder.exec('ROLLBACK');
        holder.close();
      }
    }

    expect(backupNames(dir)).toEqual([]);
  });

  it('throws DatabaseLockedError while another connection holds the lock, and opens cleanly after', async () => {
    seedDatabase(dbPath, { rows: 6 });
    const holder = new Database(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    const before = snapshotDir(dir);
    const startedAt = Date.now();

    try {
      await expect(
        BetterSqliteAdapter.create(dbPath, { busyTimeout: SMALL_BUSY_TIMEOUT_MS }),
      ).rejects.toBeInstanceOf(DatabaseLockedError);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    // A busy timeout applied before the WAL switch keeps each attempt short; the 5 s driver
    // default would make the four attempts take 20 s.
    expect(Date.now() - startedAt).toBeLessThan(LOCK_FAILURE_BUDGET_MS);
    expect(snapshotDir(dir)).toEqual(before);
    expect(backupNames(dir)).toEqual([]);

    const adapter = await BetterSqliteAdapter.create(dbPath);
    adapter.close();
    expect(countFavorites(dbPath)).toBe(6);
  });
});
