import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';
import { DatabasePermissionError } from '../indexer/db-errors.js';
import {
  PAGE_SIZE,
  backupNames,
  captureStderr,
  makeTempDir,
  snapshotDir,
  writeGarbage,
  type StderrCapture,
} from './db-open-helpers.js';

// Lets a test act right after the adapter has read the database file, which is the moment another
// process can replace it before the adapter decides what to do with what it read.
const readSeam = vi.hoisted(() => ({
  path: undefined as string | undefined,
  afterRead: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const data = actual.readFileSync(...args);
      if (String(args[0]) === readSeam.path) {
        const hook = readSeam.afterRead;
        readSeam.afterRead = undefined;
        hook?.();
      }
      return data;
    }) as typeof actual.readFileSync,
  };
});

// Counts the in-memory databases sql.js hands out and the ones that are closed again, which is the
// only way to see whether a file read and rejected left its copy behind in the WebAssembly heap.
const handles = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock('sql.js/dist/sql-asm.js', async (importOriginal) => {
  type Ctor = new (data?: ArrayLike<number> | Buffer | null) => { close(): void };
  const original = (await importOriginal()) as { default: () => Promise<{ Database: Ctor }> };
  return {
    default: async () => {
      const SQL = await original.default();
      class CountedDatabase extends SQL.Database {
        constructor(data?: ArrayLike<number> | Buffer | null) {
          super(data);
          handles.opened += 1;
        }

        override close(): void {
          handles.closed += 1;
          super.close();
        }
      }
      return { ...SQL, Database: CountedDatabase };
    },
  };
});

const CANNOT_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;
const SAME_MILLISECOND = 1_700_000_000_000;
// 300 rows of 200 bytes make a file of 18 pages of 4 KB: far more than the three a test cuts it to.
const ROW_COUNT = 300;
const ROW_PAYLOAD = 'y'.repeat(200);

async function writeHealthyDatabase(dbPath: string): Promise<void> {
  const adapter = await SqlJsAdapter.create(dbPath);
  adapter.execute('CREATE TABLE favorites (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  // One statement for all rows: every call into the asm.js build costs milliseconds on a busy
  // machine, and a statement per row made this fixture outrun the default test timeout.
  adapter.execute(
    `WITH RECURSIVE numbers (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < $count)
     INSERT INTO favorites (label) SELECT $payload || n FROM numbers`,
    { $count: ROW_COUNT, $payload: ROW_PAYLOAD },
  );
  adapter.close();
}

describe('SqlJsAdapter open: a database is only quarantined on proof of corruption', () => {
  let dir: string;
  let dbPath: string;
  let stderr: StderrCapture;

  beforeEach(() => {
    handles.opened = 0;
    handles.closed = 0;
    dir = makeTempDir('open-sqljs');
    dbPath = join(dir, 'vault.db');
    stderr = captureStderr();
  });

  afterEach(() => {
    readSeam.path = undefined;
    readSeam.afterRead = undefined;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the file mode of a database that already exists',
    async () => {
      // A small file: filling the database with thousands of rows takes seconds on a busy machine.
      const seed = await SqlJsAdapter.create(dbPath);
      seed.execute('CREATE TABLE favorites (id INTEGER PRIMARY KEY)');
      seed.close();
      const groupReadable = 0o640;
      chmodSync(dbPath, groupReadable);

      (await SqlJsAdapter.create(dbPath)).close();

      // Only a database this open creates is made owner-only; one that exists is the user's to manage.
      expect(statSync(dbPath).mode & 0o777).toBe(groupReadable);
      expect(backupNames(dir)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates a brand-new database with owner-only permissions',
    async () => {
      (await SqlJsAdapter.create(dbPath)).close();

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(backupNames(dir)).toEqual([]);
    },
  );

  it('round-trips a healthy database with no backup and no notice', async () => {
    await writeHealthyDatabase(dbPath);

    const adapter = await SqlJsAdapter.create(dbPath);
    expect(adapter.queryOne<{ c: number }>('SELECT count(*) AS c FROM favorites')?.c).toBe(
      ROW_COUNT,
    );
    adapter.close();

    expect(backupNames(dir)).toEqual([]);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it('saves a garbage file byte-for-byte under a backup name and announces it once', async () => {
    const garbage = writeGarbage(dbPath);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const adapter = await SqlJsAdapter.create(dbPath);
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.execute('INSERT INTO fresh (id) VALUES (9)');
    expect(adapter.queryOne<{ id: number }>('SELECT id FROM fresh')?.id).toBe(9);
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(garbage)).toBe(true);
    expect(stderr.lines().filter((line) => line.includes(join(dir, backup!)))).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(readFileSync(dbPath).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('frees the in-memory copy of a file it rejected as corrupt', async () => {
    writeGarbage(dbPath);

    const adapter = await SqlJsAdapter.create(dbPath);
    adapter.close();

    // One handle for the rejected file, one for the new empty database.
    expect(handles.opened).toBe(2);
    expect(handles.closed).toBe(handles.opened);
  });

  it('treats a short non-SQLite text file as corrupt and keeps its bytes', async () => {
    const text = Buffer.from('not a database file at all');
    writeFileSync(dbPath, text);

    (await SqlJsAdapter.create(dbPath)).close();

    const [backup] = backupNames(dir);
    expect(readFileSync(join(dir, backup!)).equals(text)).toBe(true);
  });

  it('keeps the bytes of a database truncated at a page boundary', async () => {
    await writeHealthyDatabase(dbPath);
    truncateSync(dbPath, PAGE_SIZE * 3);
    const truncatedBytes = readFileSync(dbPath);

    (await SqlJsAdapter.create(dbPath)).close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(truncatedBytes)).toBe(true);
  });

  it('never overwrites an earlier backup when a second corruption happens', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SAME_MILLISECOND);
    const firstGarbage = writeGarbage(dbPath);
    (await SqlJsAdapter.create(dbPath)).close();
    const secondGarbage = writeGarbage(dbPath);
    (await SqlJsAdapter.create(dbPath)).close();

    const contents = backupNames(dir).map((name) => readFileSync(join(dir, name)));
    expect(contents).toHaveLength(2);
    expect(contents.some((bytes) => bytes.equals(firstGarbage))).toBe(true);
    expect(contents.some((bytes) => bytes.equals(secondGarbage))).toBe(true);
  });

  it('keeps a corrupt file whose name does not end in .db', async () => {
    const odd = join(dir, 'vault.sqlite3');
    const garbage = writeGarbage(odd);

    (await SqlJsAdapter.create(odd)).close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(garbage)).toBe(true);
  });

  it('keeps the -wal and -shm sidecars with the backup of a quarantined database', async () => {
    const garbage = writeGarbage(dbPath);
    const staleWal = randomBytes(512);
    const staleShm = randomBytes(256);
    writeFileSync(`${dbPath}-wal`, staleWal);
    writeFileSync(`${dbPath}-shm`, staleShm);

    (await SqlJsAdapter.create(dbPath)).close();

    const [backup] = backupNames(dir);
    const backupPath = join(dir, backup!);
    expect(readFileSync(backupPath).equals(garbage)).toBe(true);
    expect(readFileSync(`${backupPath}-wal`).equals(staleWal)).toBe(true);
    expect(readFileSync(`${backupPath}-shm`).equals(staleShm)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(
      [backup, `${backup}-shm`, `${backup}-wal`, 'vault.db'].sort(),
    );
  });

  it.skipIf(CANNOT_CHMOD)(
    'reports a permission error for an unreadable file and leaves it untouched',
    async () => {
      await writeHealthyDatabase(dbPath);
      const before = snapshotDir(dir);
      chmodSync(dbPath, 0o000);

      try {
        const failure = await SqlJsAdapter.create(dbPath).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(DatabasePermissionError);
        expect((failure as Error).message).toContain(dbPath);
      } finally {
        chmodSync(dbPath, 0o600);
      }

      expect(backupNames(dir)).toEqual([]);
      expect(snapshotDir(dir)).toEqual(before);
    },
  );

  it.skipIf(CANNOT_CHMOD)(
    'reports a permission error for a healthy file it may read but not change, and frees the copy',
    async () => {
      await writeHealthyDatabase(dbPath);
      const before = snapshotDir(dir);
      const openedBefore = handles.opened;
      const closedBefore = handles.closed;
      chmodSync(dbPath, 0o444);

      try {
        const failure = await SqlJsAdapter.create(dbPath).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(DatabasePermissionError);
        expect((failure as Error).message).toContain(dbPath);
      } finally {
        chmodSync(dbPath, 0o600);
      }

      expect(backupNames(dir)).toEqual([]);
      expect(snapshotDir(dir)).toEqual(before);
      expect(handles.opened - openedBefore).toBe(handles.closed - closedBefore);
    },
  );

  it('quarantines a damaged schema entry, which sql.js reports without an error code', async () => {
    await writeHealthyDatabase(dbPath);
    const bytes = readFileSync(dbPath);
    bytes.write('XREATE', bytes.indexOf('CREATE TABLE'));
    writeFileSync(dbPath, bytes);

    const adapter = await SqlJsAdapter.create(dbPath);
    adapter.execute('CREATE TABLE fresh (id INTEGER)');
    adapter.close();

    const [backup] = backupNames(dir);
    expect(backupNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, backup!)).equals(bytes)).toBe(true);
  });

  it('leaves a schema it cannot parse alone: that may be a healthy file from a newer engine', async () => {
    const initSqlJs = ((await import('sql.js/dist/sql-asm.js')) as unknown as { default: never })
      .default as () => Promise<{
      Database: new () => {
        run(sql: string): void;
        export(): Uint8Array;
        close(): void;
      };
    }>;
    const SQL = await initSqlJs();
    const crafted = new SQL.Database();
    crafted.run('CREATE TABLE k (a)');
    crafted.run('PRAGMA writable_schema = ON');
    crafted.run(
      "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'k2', 'k2', 2, 'CREATE TABLE k2 (a,,)')",
    );
    writeFileSync(dbPath, Buffer.from(crafted.export()));
    crafted.close();
    const before = snapshotDir(dir);

    const failure = await SqlJsAdapter.create(dbPath).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toMatch(/^malformed database schema \(k2\) - near/);
    expect(backupNames(dir)).toEqual([]);
    expect(snapshotDir(dir)).toEqual(before);
  });

  it('does not quarantine a file that another process replaced while it was being read', async () => {
    const replacement = join(dir, 'replacement.db');
    await writeHealthyDatabase(replacement);
    writeGarbage(dbPath);
    readSeam.path = dbPath;
    readSeam.afterRead = () => renameSync(replacement, dbPath);

    const adapter = await SqlJsAdapter.create(dbPath);
    expect(adapter.queryOne<{ c: number }>('SELECT count(*) AS c FROM favorites')?.c).toBe(
      ROW_COUNT,
    );
    adapter.close();

    expect(backupNames(dir)).toEqual([]);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  it('rethrows an unrecognised read failure untouched and changes nothing', async () => {
    mkdirSync(dbPath);

    const failure = await SqlJsAdapter.create(dbPath).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(readdirSync(dir)).toEqual(['vault.db']);
  });
});
