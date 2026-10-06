import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { BetterSqliteAdapter } from '../indexer/better-sqlite-adapter.js';
import type { DatabaseAdapter } from '../indexer/database-adapter.js';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';
import { withReadonlyDatabase } from './migration-fixtures.js';

const SHORT_BUSY_TIMEOUT_MS = 50;
const ROWS = 3;

function countRows(adapter: DatabaseAdapter): number {
  return adapter.queryOne<{ n: number }>('SELECT count(*) AS n FROM t')?.n ?? -1;
}

describe('transactions and backups on the native adapter', () => {
  let tempDir: string;
  let dbPath: string;
  let writer: BetterSqliteAdapter;
  let rival: BetterSqliteAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-adapter-txn-'));
    dbPath = join(tempDir, 'vault.db');
    writer = await BetterSqliteAdapter.create(dbPath);
    writer.execute('CREATE TABLE t (x INTEGER)');
    for (let row = 0; row < ROWS; row += 1)
      writer.execute('INSERT INTO t VALUES ($x)', { $x: row });
    rival = await BetterSqliteAdapter.create(dbPath, { busyTimeout: SHORT_BUSY_TIMEOUT_MS });
  });

  afterEach(async () => {
    writer.close();
    rival.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stays in rollback-journal mode until asked to switch to write-ahead logging', async () => {
    const path = join(tempDir, 'deferred.db');
    const adapter = await BetterSqliteAdapter.create(path, { walMode: false });
    try {
      const mode = (): string | undefined =>
        adapter.queryOne<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode;
      expect(mode()).toBe('delete');

      adapter.enableWriteAheadLog();

      expect(mode()).toBe('wal');
    } finally {
      adapter.close();
    }
  });

  it('waits ten seconds for a lock unless told otherwise', async () => {
    const patient = await BetterSqliteAdapter.create(dbPath);
    try {
      expect(patient.queryOne<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(10_000);
    } finally {
      patient.close();
    }
  });

  it('takes the write lock when an immediate transaction starts', () => {
    let rivalWasBlocked = false;

    writer.transaction(
      () => {
        try {
          rival.execute('INSERT INTO t VALUES (100)');
        } catch (error) {
          rivalWasBlocked = /database is locked/.test((error as Error).message);
        }
      },
      { mode: 'immediate' },
    );

    expect(rivalWasBlocked).toBe(true);
    expect(countRows(rival)).toBe(ROWS);
  });

  it('takes it at the first write when the transaction is deferred', () => {
    writer.transaction(() => {
      rival.execute('INSERT INTO t VALUES (100)');
    });

    expect(countRows(writer)).toBe(ROWS + 1);
  });

  it('commits what the function wrote and returns its result', () => {
    const result = writer.transaction(
      () => {
        writer.execute('INSERT INTO t VALUES (200)');
        return 'done';
      },
      { mode: 'immediate' },
    );

    expect(result).toBe('done');
    expect(countRows(rival)).toBe(ROWS + 1);
  });

  it('rolls back what the function wrote when it throws, and lets the error through', () => {
    expect(() =>
      writer.transaction(
        () => {
          writer.execute('INSERT INTO t VALUES (200)');
          throw new Error('boom');
        },
        { mode: 'immediate' },
      ),
    ).toThrow('boom');

    expect(countRows(rival)).toBe(ROWS);
  });

  it('backs up the last committed state, also from inside a transaction', () => {
    const destination = join(tempDir, 'copy.db');

    writer.transaction(
      () => {
        writer.execute('INSERT INTO t VALUES (300)');
        writer.backupTo(destination);
      },
      { mode: 'immediate' },
    );

    // The copy holds the rows that were committed, not the one written inside the transaction.
    const copiedRows = withReadonlyDatabase(
      destination,
      (db) => (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n,
    );
    expect(copiedRows).toBe(ROWS);
    expect(countRows(writer)).toBe(ROWS + 1);
  });

  it('refuses to overwrite a file that already exists, and leaves it as it is', () => {
    const destination = join(tempDir, 'copy.db');
    writeFileSync(destination, 'precious');

    expect(() => writer.backupTo(destination)).toThrow(/EEXIST|already exists/);

    expect(readFileSync(destination, 'utf8')).toBe('precious');
  });

  // Copying the pages as they are is the way around damage only. A copy that fails for any other
  // reason (a full disk, for one) would get the same treatment and fail, or worse, half-succeed.
  it('reports a copy that fails for a reason other than damage, instead of copying the pages', () => {
    const destination = join(tempDir, 'copy.db');
    const diskFull = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    const prepare = Database.prototype.prepare;
    const serialize = vi.spyOn(Database.prototype, 'serialize');
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql.startsWith('VACUUM INTO')) throw diskFull;
      return prepare.call(this, sql);
    } as typeof Database.prototype.prepare);

    try {
      expect(() => writer.backupTo(destination)).toThrow(diskFull);
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // The copy is the whole vault: it is owner-only from its first byte, not after a chmod that the
  // caller gets around to once the copy is complete.
  it.skipIf(process.platform === 'win32')('writes the backup readable by its owner only', () => {
    const destination = join(tempDir, 'copy.db');

    writer.backupTo(destination);

    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });
});

describe('transactions and backups on the sql.js adapter', () => {
  let tempDir: string;
  let dbPath: string;
  let adapter: SqlJsAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-adapter-txn-sqljs-'));
    dbPath = join(tempDir, 'vault.db');
    adapter = await SqlJsAdapter.create(dbPath);
    adapter.execute('CREATE TABLE t (x INTEGER)');
    adapter.persist();
  });

  afterEach(async () => {
    adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs an immediate transaction and keeps what it wrote', () => {
    adapter.transaction(() => adapter.execute('INSERT INTO t VALUES (1)'), { mode: 'immediate' });

    expect(countRows(adapter)).toBe(1);
  });

  it('rolls back and reports the original error, even if SQLite had already rolled back', () => {
    expect(() =>
      adapter.transaction(
        () => {
          adapter.execute('INSERT INTO t VALUES (1)');
          // What SQLite does by itself after some failures; a second ROLLBACK then has nothing to end.
          adapter.execute('ROLLBACK');
          throw new Error('boom');
        },
        { mode: 'immediate' },
      ),
    ).toThrow('boom');

    expect(countRows(adapter)).toBe(0);
    // The failed transaction left nothing open behind it.
    adapter.transaction(() => adapter.execute('INSERT INTO t VALUES (2)'), { mode: 'immediate' });
    expect(countRows(adapter)).toBe(1);
  });

  it('backs up the saved file as it is, from inside a transaction', () => {
    const destination = join(tempDir, 'copy.db');

    adapter.transaction(() => adapter.backupTo(destination), { mode: 'immediate' });

    expect(readFileSync(destination).equals(readFileSync(dbPath))).toBe(true);
  });

  it('refuses to overwrite a file that already exists, and leaves it as it is', () => {
    const destination = join(tempDir, 'copy.db');
    writeFileSync(destination, 'precious');

    expect(() => adapter.backupTo(destination)).toThrow(/EEXIST|already exists/);

    expect(readFileSync(destination, 'utf8')).toBe('precious');
  });

  it.skipIf(process.platform === 'win32')('writes the backup readable by its owner only', () => {
    chmodSync(dbPath, 0o644);
    const destination = join(tempDir, 'copy.db');

    adapter.backupTo(destination);

    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it('will not back up changes that are not saved yet, which it could only do by ending the transaction', () => {
    adapter.execute('INSERT INTO t VALUES (1)');

    expect(() => adapter.backupTo(join(tempDir, 'copy.db'))).toThrow(/not yet saved/);
  });
});
