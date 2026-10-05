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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { DatabasePermissionError } from '../indexer/db-errors.js';
import { fileFingerprint, quarantineCorruptDatabase } from '../indexer/quarantine.js';
import { captureStderr, makeTempDir, snapshotDir, type StderrCapture } from './db-open-helpers.js';

const CANNOT_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;
const FIXED_NOW = 1_700_000_000_000;

describe('quarantineCorruptDatabase', () => {
  let dir: string;
  let dbPath: string;
  let stderr: StderrCapture;

  beforeEach(() => {
    dir = makeTempDir('quarantine');
    dbPath = join(dir, 'vault.db');
    stderr = captureStderr();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves the database and every sidecar under one backup name, empties the original and announces it once', () => {
    writeFileSync(dbPath, 'main');
    writeFileSync(`${dbPath}-wal`, 'wal');
    writeFileSync(`${dbPath}-shm`, 'shm');
    writeFileSync(`${dbPath}-journal`, 'journal');

    const backup = quarantineCorruptDatabase(dbPath, fileFingerprint(dbPath), new Error('bad'));

    expect(backup).toMatch(/vault\.db\.corrupt\.\d+\.bak$/);
    expect(readFileSync(backup!, 'utf8')).toBe('main');
    expect(readFileSync(`${backup}-wal`, 'utf8')).toBe('wal');
    expect(readFileSync(`${backup}-shm`, 'utf8')).toBe('shm');
    expect(readFileSync(`${backup}-journal`, 'utf8')).toBe('journal');
    // The copies are owner-only even though the originals here were created world-readable.
    if (process.platform !== 'win32') {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        expect(statSync(`${backup}${suffix}`).mode & 0o777).toBe(0o600);
      }
    }
    // The database file stays, now empty and owner-only; its sidecars are gone, so none is replayed.
    expect(readFileSync(dbPath)).toHaveLength(0);
    if (process.platform !== 'win32') expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(
      [
        'vault.db',
        ...['', '-wal', '-shm', '-journal'].map((suffix) => basename(backup!) + suffix),
      ].sort(),
    );
    expect(stderr.lines().filter((line) => line.includes(backup!))).toHaveLength(1);
  });

  it('keeps the inode of the database file, so connections already open on it agree with the path', () => {
    writeFileSync(dbPath, 'corrupt');
    const inodeBefore = statSync(dbPath).ino;

    quarantineCorruptDatabase(dbPath, fileFingerprint(dbPath), new Error('bad'));

    expect(statSync(dbPath).ino).toBe(inodeBefore);
  });

  it('adds a counter instead of overwriting a backup that already has the name', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const taken = `${dbPath}.corrupt.${FIXED_NOW}.bak`;
    writeFileSync(taken, 'earlier backup');
    writeFileSync(`${taken}-wal`, 'earlier wal');
    writeFileSync(dbPath, 'second');

    const backup = quarantineCorruptDatabase(dbPath, fileFingerprint(dbPath), new Error('bad'));

    expect(backup).toBe(`${dbPath}.corrupt.${FIXED_NOW}-1.bak`);
    expect(readFileSync(taken, 'utf8')).toBe('earlier backup');
    expect(readFileSync(`${taken}-wal`, 'utf8')).toBe('earlier wal');
    expect(readFileSync(backup!, 'utf8')).toBe('second');
  });

  it('skips a backup name whose sidecar is already taken, so an orphan sidecar survives', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    // A sidecar left behind by an earlier quarantine that never finished, with no main file.
    const orphan = `${dbPath}.corrupt.${FIXED_NOW}.bak-wal`;
    writeFileSync(orphan, 'orphan wal');
    writeFileSync(dbPath, 'second');
    writeFileSync(`${dbPath}-wal`, 'second wal');

    const backup = quarantineCorruptDatabase(dbPath, fileFingerprint(dbPath), new Error('bad'));

    expect(backup).toBe(`${dbPath}.corrupt.${FIXED_NOW}-1.bak`);
    expect(readFileSync(orphan, 'utf8')).toBe('orphan wal');
    expect(readFileSync(`${backup}-wal`, 'utf8')).toBe('second wal');
  });

  it('keeps counting when several backups share the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const backups = ['a', 'b', 'c'].map((content) => {
      writeFileSync(dbPath, content);
      return quarantineCorruptDatabase(dbPath, fileFingerprint(dbPath), new Error('bad'));
    });

    expect(new Set(backups).size).toBe(3);
    expect(backups.map((path) => readFileSync(path!, 'utf8'))).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['replaced by another file', () => renameSync(writeOther(), dbPath)],
    ['rewritten in place', () => writeFileSync(dbPath, 'healthy content, a different length')],
    ['emptied by another repair', () => truncateSync(dbPath, 0)],
  ])('does nothing when the file was %s since it failed', (_what, change) => {
    writeFileSync(dbPath, 'corrupt');
    const failedFingerprint = fileFingerprint(dbPath);
    change();
    const before = snapshotDir(dir);

    expect(quarantineCorruptDatabase(dbPath, failedFingerprint, new Error('bad'))).toBeUndefined();

    expect(snapshotDir(dir)).toEqual(before);
    expect(stderr.lines().join('')).not.toContain('CommandVault:');
  });

  describe('the identity of the failed file', () => {
    const LONG_AGO_SECONDS = 1_600_000_000;

    it('changes when the file is rewritten in place to the same size, by its modification time', () => {
      writeFileSync(dbPath, 'corrupt');
      utimesSync(dbPath, LONG_AGO_SECONDS, LONG_AGO_SECONDS);
      const failedFingerprint = fileFingerprint(dbPath);
      const inodeBefore = statSync(dbPath).ino;
      writeFileSync(dbPath, 'healthy'); // same inode, same length, written just now
      expect(statSync(dbPath).ino).toBe(inodeBefore);
      const before = snapshotDir(dir);

      expect(
        quarantineCorruptDatabase(dbPath, failedFingerprint, new Error('bad')),
      ).toBeUndefined();

      expect(snapshotDir(dir)).toEqual(before);
    });

    it('changes when the file is rewritten in place to another size, by its size alone', () => {
      writeFileSync(dbPath, 'corrupt');
      utimesSync(dbPath, LONG_AGO_SECONDS, LONG_AGO_SECONDS);
      const failedFingerprint = fileFingerprint(dbPath);
      const inodeBefore = statSync(dbPath).ino;
      // What another repair leaves on a file system with a coarse clock: the same inode and the same
      // modification time, because the rewrite fell within one tick of the time the file had.
      writeFileSync(dbPath, 'emptied and filled again, a different length');
      utimesSync(dbPath, LONG_AGO_SECONDS, LONG_AGO_SECONDS);
      expect(statSync(dbPath).ino).toBe(inodeBefore);
      const before = snapshotDir(dir);

      expect(fileFingerprint(dbPath)).not.toBe(failedFingerprint);
      expect(
        quarantineCorruptDatabase(dbPath, failedFingerprint, new Error('bad')),
      ).toBeUndefined();

      expect(snapshotDir(dir)).toEqual(before);
    });

    it.skipIf(process.platform === 'win32')(
      'changes when the file is replaced by another of the same size and time, by its inode',
      () => {
        // Windows reports no inode number through stat, so a replacement there is told apart by the rest.
        writeFileSync(dbPath, 'corrupt');
        utimesSync(dbPath, LONG_AGO_SECONDS, LONG_AGO_SECONDS);
        const failedFingerprint = fileFingerprint(dbPath);
        const other = writeOther();
        writeFileSync(other, 'healthy');
        utimesSync(other, LONG_AGO_SECONDS, LONG_AGO_SECONDS);
        renameSync(other, dbPath);
        const before = snapshotDir(dir);

        expect(
          quarantineCorruptDatabase(dbPath, failedFingerprint, new Error('bad')),
        ).toBeUndefined();

        expect(snapshotDir(dir)).toEqual(before);
      },
    );
  });

  function writeOther(): string {
    const other = join(dir, 'other');
    writeFileSync(other, 'healthy replacement');
    return other;
  }

  it('does nothing when the file has vanished', () => {
    expect(quarantineCorruptDatabase(dbPath, undefined, new Error('bad'))).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(CANNOT_CHMOD)(
    'turns a read-only folder into a permission error and leaves the file alone',
    () => {
      const folder = join(dir, 'locked');
      mkdirSync(folder);
      const lockedDb = join(folder, 'vault.db');
      writeFileSync(lockedDb, 'corrupt');
      const fingerprint = fileFingerprint(lockedDb);
      chmodSync(folder, 0o500);

      try {
        expect(() => quarantineCorruptDatabase(lockedDb, fingerprint, new Error('bad'))).toThrow(
          DatabasePermissionError,
        );
      } finally {
        chmodSync(folder, 0o700);
      }

      expect(readdirSync(folder)).toEqual(['vault.db']);
      expect(readFileSync(lockedDb, 'utf8')).toBe('corrupt');
    },
  );
});
