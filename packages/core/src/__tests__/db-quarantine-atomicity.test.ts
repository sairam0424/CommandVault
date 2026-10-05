import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  DatabaseIoError,
  DatabaseOpenError,
  DatabasePermissionError,
} from '../indexer/db-errors.js';
import { fileFingerprint, quarantineCorruptDatabase } from '../indexer/quarantine.js';
import {
  captureStderr,
  catchError,
  countFavorites,
  fsError,
  makeTempDir,
  seedDatabase,
  snapshotDir,
  writeCorruptSet as writeCorruptDatabaseSet,
  type StderrCapture,
} from './db-open-helpers.js';
import { resetSeam, seam } from './db-fs-seam.js';

vi.mock('node:fs', async (importOriginal) => {
  const { withSeam } = await import('./db-fs-seam.js');
  return withSeam(await importOriginal<typeof import('node:fs')>());
});

describe('quarantineCorruptDatabase saves first, then empties, all or nothing', () => {
  let dir: string;
  let dbPath: string;
  let stderr: StderrCapture;

  beforeEach(() => {
    dir = makeTempDir('quarantine-atomic');
    dbPath = join(dir, 'vault.db');
    stderr = captureStderr();
  });

  afterEach(() => {
    resetSeam();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function notices(): string[] {
    return stderr.lines().filter((line) => line.startsWith('CommandVault:'));
  }

  const writeCorruptSet = (): string | undefined => writeCorruptDatabaseSet(dbPath);

  function quarantine(fingerprint: string | undefined): unknown {
    return catchError(() => quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad')));
  }

  it('saves every file before it deletes or empties anything', () => {
    const fingerprint = writeCorruptSet();
    const steps: string[] = [];
    seam.beforeCopy = (from) => steps.push(`copy ${basename(from)}`);
    seam.beforeUnlink = (path) => {
      if (!path.includes('.quarantine.lock')) steps.push(`unlink ${basename(path)}`);
    };
    seam.beforeTruncate = (path) => steps.push(`truncate ${basename(path)}`);

    quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    // A stale -wal or -journal left beside the emptied file would be replayed into the new database.
    expect(steps).toEqual([
      'copy vault.db-wal',
      'copy vault.db-shm',
      'copy vault.db-journal',
      'copy vault.db',
      'unlink vault.db-wal',
      'unlink vault.db-shm',
      'unlink vault.db-journal',
      'truncate vault.db',
    ]);
  });

  it('leaves a database alone that another process repaired while it was being copied', () => {
    const fingerprint = writeCorruptSet();
    seedDatabase(join(dir, 'healthy.db'), { rows: 4 });
    const healthy = readFileSync(join(dir, 'healthy.db'));
    rmSync(join(dir, 'healthy.db'));
    // A process that ignores the quarantine lock (an older version, a sync tool) gets there first:
    // it empties the corrupt file and puts a healthy database into it.
    seam.beforeCopy = (from) => {
      if (from !== dbPath) return;
      seam.beforeCopy = undefined;
      writeFileSync(dbPath, healthy);
    };

    const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(result).toBeUndefined();
    expect(readFileSync(dbPath).equals(healthy)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(
      ['vault.db', 'vault.db-journal', 'vault.db-shm', 'vault.db-wal'].sort(),
    );
    expect(notices()).toEqual([]);
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${dbPath}${suffix}`);
    expect(countFavorites(dbPath)).toBe(4);
  });

  it('does not even copy a file that already changed since it failed', () => {
    const fingerprint = writeCorruptSet();
    // Another process repaired it before this one got the lock: copying a healthy database of any
    // size would be wasted work, and the copy would only be thrown away.
    writeFileSync(dbPath, 'repaired meanwhile, so a different length');
    const copied: string[] = [];
    seam.beforeCopy = (from) => copied.push(from);

    const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(result).toBeUndefined();
    expect(copied).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it('treats a file that vanished during the copy as handled, leaving no copies behind', () => {
    const fingerprint = writeCorruptSet();
    seam.beforeCopy = (from) => {
      if (from !== dbPath) return;
      seam.beforeCopy = undefined;
      renameSync(dbPath, join(dir, 'moved-by-the-winner'));
    };

    const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(result).toBeUndefined();
    expect(readdirSync(dir).sort()).toEqual(
      ['moved-by-the-winner', 'vault.db-journal', 'vault.db-shm', 'vault.db-wal'].sort(),
    );
    expect(notices()).toEqual([]);
  });

  it('undoes a part-way deletion, so "database not modified" stays true', () => {
    const fingerprint = writeCorruptSet();
    const before = snapshotDir(dir);
    seam.beforeUnlink = (path) => {
      if (path === `${dbPath}-shm`) throw fsError('EPERM', 'unlink');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(DatabasePermissionError);
    expect((failure as Error).message).toMatch(/database not modified/i);
    expect(snapshotDir(dir)).toEqual(before);
    expect(notices()).toEqual([]);
  });

  it('puts the sidecars back and removes its copies when the file cannot be emptied', () => {
    const fingerprint = writeCorruptSet();
    const before = snapshotDir(dir);
    seam.beforeTruncate = (path) => {
      if (path === dbPath) throw fsError('EPERM', 'truncate');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(DatabasePermissionError);
    expect(snapshotDir(dir)).toEqual(before);
  });

  it('removes its copies and the reserved name when a copy cannot be completed', () => {
    const fingerprint = writeCorruptSet();
    const before = snapshotDir(dir);
    seam.beforeCopy = (from) => {
      if (from === dbPath) throw fsError('ENOSPC', 'copy');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(DatabaseIoError);
    expect(snapshotDir(dir)).toEqual(before);
  });

  it('removes a sidecar copy that could not be finished, however early in its writing it failed', () => {
    const fingerprint = writeCorruptSet();
    const before = snapshotDir(dir);
    // The backup file exists by now, so it must be known to the undo before anything can fail.
    seam.afterCopy = (to) => {
      if (to.endsWith('.bak-wal')) throw fsError('ENOSPC', 'fsync');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(DatabaseIoError);
    expect(snapshotDir(dir)).toEqual(before);
  });

  it('refuses to empty the original when its copy came out short', () => {
    const fingerprint = writeCorruptSet();
    const before = snapshotDir(dir);
    seam.afterCopy = (to) => {
      if (to.endsWith('.bak')) truncateSync(to, 3);
    };

    const failure = quarantine(fingerprint);

    expect((failure as Error).message).toMatch(/incomplete/);
    expect(snapshotDir(dir)).toEqual(before);
  });

  it.each([
    ['the database file', ''],
    ['the -wal file', '-wal'],
    ['the -shm file', '-shm'],
    ['the -journal file', '-journal'],
  ])('changes nothing when the read of %s comes up short of its size', (_label, suffix) => {
    const fingerprint = writeCorruptSet();
    const before = snapshotDir(dir);
    let readShort = false;
    // No file is touched, so the fingerprint still matches: only the bytes read fall short of what
    // fstat reported. Carrying on would empty the database with only a part of it saved.
    seam.afterRead = (from, content) => {
      if (from !== dbPath + suffix) return content;
      readShort = true;
      return content.subarray(0, content.length - 1);
    };

    const result = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(readShort).toBe(true);
    expect(result).toBeUndefined();
    expect(snapshotDir(dir)).toEqual(before); // byte-identical, and no copy or reserved name left
    expect(notices()).toEqual([]);
  });

  it('names every file it could not put back instead of claiming nothing changed', () => {
    const fingerprint = writeCorruptSet();
    seam.beforeUnlink = (path) => {
      if (path === `${dbPath}-shm`) throw fsError('EPERM', 'unlink');
    };
    seam.beforeCopy = (_from, to) => {
      if (to === `${dbPath}-wal`) throw fsError('EIO', 'copy back');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(DatabaseOpenError);
    expect(failure).not.toBeInstanceOf(DatabasePermissionError);
    const saved = readdirSync(dir).find((name) => name.endsWith('.bak-wal'));
    expect(saved).toBeDefined();
    expect((failure as Error).message).toContain(join(dir, saved!));
    expect((failure as Error).message).toContain(`${dbPath}-wal`);
    expect((failure as Error).message).toContain('simulated failure, copy back');
    expect((failure as Error).message).toMatch(/nothing was deleted/i);
    expect(readFileSync(join(dir, saved!), 'utf8')).toBe('wal');
    // The database file itself was never emptied.
    expect(readFileSync(dbPath, 'utf8')).toBe('corrupt');
  });

  it('never overwrites a file that appeared at a backup sidecar name after the name was chosen', () => {
    const fingerprint = writeCorruptSet();
    let squatter: string | undefined;
    seam.beforeCopy = (from, to) => {
      if (from !== `${dbPath}-wal` || to === undefined) return;
      squatter = to;
      writeFileSync(to, 'written by someone else');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(Error);
    expect(readFileSync(squatter!, 'utf8')).toBe('written by someone else');
    // Nothing of the database changed, and the only extra file is the one that was not ours.
    expect(readFileSync(dbPath, 'utf8')).toBe('corrupt');
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('wal');
    expect(readdirSync(dir).sort()).toEqual(
      ['vault.db', 'vault.db-journal', 'vault.db-shm', 'vault.db-wal', basename(squatter!)].sort(),
    );
  });

  it('never overwrites a sidecar that another process created while it was undoing a failure', () => {
    const fingerprint = writeCorruptSet();
    seam.beforeTruncate = (path) => {
      if (path !== dbPath) return;
      // The sidecars are already deleted here; a connection elsewhere starts a new -wal before the undo.
      writeFileSync(`${dbPath}-wal`, 'new wal of another connection');
      throw fsError('EPERM', 'truncate');
    };

    const failure = quarantine(fingerprint);

    expect(failure).toBeInstanceOf(DatabaseOpenError);
    expect(failure).not.toBeInstanceOf(DatabasePermissionError);
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('new wal of another connection');
    // The undo says where the old one is instead, and the other sidecars went back.
    const saved = readdirSync(dir).find((name) => name.endsWith('.bak-wal'));
    expect((failure as Error).message).toContain(join(dir, saved!));
    expect(readFileSync(join(dir, saved!), 'utf8')).toBe('wal');
    expect(readFileSync(`${dbPath}-shm`, 'utf8')).toBe('shm');
    expect(readFileSync(`${dbPath}-journal`, 'utf8')).toBe('journal');
  });

  it('carries on when a sidecar is already gone by the time it deletes it', () => {
    const fingerprint = writeCorruptSet();
    // SQLite or another process removes the -shm between the copy and the delete.
    seam.beforeUnlink = (path) => {
      if (path === `${dbPath}-shm`) rmSync(path);
    };

    const backup = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(backup).toBeDefined();
    expect(readFileSync(`${backup}-shm`, 'utf8')).toBe('shm');
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(readFileSync(dbPath)).toHaveLength(0);
  });

  it('does not delete a sidecar that appeared after the copies were made and is in no backup', () => {
    writeFileSync(dbPath, 'corrupt');
    writeFileSync(`${dbPath}-shm`, 'shm');
    const fingerprint = fileFingerprint(dbPath);
    let appeared = false;
    // A connection of another process starts a write-ahead log once the copies are made.
    seam.beforeUnlink = (path) => {
      if (appeared || !path.startsWith(`${dbPath}-`)) return;
      appeared = true;
      writeFileSync(`${dbPath}-wal`, 'frames of another connection');
    };

    const backup = quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'));

    expect(backup).toBeDefined();
    expect(appeared).toBe(true);
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('frames of another connection');
    expect(existsSync(`${backup}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
