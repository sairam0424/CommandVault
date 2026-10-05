import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BetterSqliteAdapter } from '../indexer/better-sqlite-adapter.js';
import { DatabaseLockedError, DatabasePermissionError } from '../indexer/db-errors.js';
import { quarantineCorruptDatabase } from '../indexer/quarantine.js';
import { withRegisteredOpener } from '../indexer/quarantine-openers.js';
import {
  backupNames,
  captureStderr,
  catchError,
  deadProcessId,
  fsError,
  makeTempDir,
  seedDatabase,
  snapshotDir,
  writeCorruptSet,
} from './db-open-helpers.js';
import { resetSeam, seam } from './db-fs-seam.js';

vi.mock('node:fs', async (importOriginal) => {
  const { withSeam } = await import('./db-fs-seam.js');
  return withSeam(await importOriginal<typeof import('node:fs')>());
});

const SHORT_WAIT_MS = 60;
const MARKER_INFIX = '.opening.';
// A live process other than this one, standing for another CommandVault process.
const otherProcessId = process.ppid;

describe('an open and a repair of the same database never overlap', () => {
  let dir: string;
  let dbPath: string;
  let lockPath: string;

  beforeEach(() => {
    dir = makeTempDir('openers');
    dbPath = join(dir, 'vault.db');
    lockPath = `${dbPath}.quarantine.lock`;
    captureStderr();
  });

  afterEach(() => {
    resetSeam();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const markers = (): string[] => readdirSync(dir).filter((name) => name.includes(MARKER_INFIX));

  /** Stands in for the repair that holds the lock finishing: `onPoll` runs when it is looked at. */
  function finishRepairWhenLookedAt(onPoll: () => void = () => undefined): void {
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === otherProcessId && existsSync(lockPath)) {
        onPoll();
        rmSync(lockPath);
      }
      return realKill(pid, signal);
    }) as typeof process.kill);
  }

  function holdLockAs(processId: number): void {
    writeFileSync(lockPath, `${processId}\n`, { flag: 'wx' });
  }

  describe('an open', () => {
    it('leaves a marker while it runs and none afterwards', () => {
      let markersWhileOpen: string[] = [];

      const result = withRegisteredOpener(dbPath, () => {
        markersWhileOpen = markers();
        return 'opened';
      });

      expect(result).toBe('opened');
      expect(markersWhileOpen).toHaveLength(1);
      expect(markersWhileOpen[0]).toContain(`${MARKER_INFIX}${process.pid}.`);
      expect(markers()).toEqual([]);
    });

    it('leaves no marker when the open fails, and lets the failure through', () => {
      const failure = catchError(() =>
        withRegisteredOpener(dbPath, () => {
          throw new Error('the open failed');
        }),
      );

      expect((failure as Error).message).toBe('the open failed');
      expect(markers()).toEqual([]);
    });

    it('does not start while a repair holds the lock, and starts when the repair is done', () => {
      holdLockAs(otherProcessId);
      const markersWhileWaiting: string[][] = [];
      finishRepairWhenLookedAt(() => markersWhileWaiting.push(markers()));
      const open = vi.fn(() => {
        expect(existsSync(lockPath)).toBe(false);
        return 'opened';
      });

      expect(withRegisteredOpener(dbPath, open)).toBe('opened');

      expect(open).toHaveBeenCalledTimes(1);
      expect(markersWhileWaiting).toEqual([[]]);
    });

    it('steps aside when a repair takes the lock after it has registered', () => {
      // The repair cannot see this open yet, so the open has to look for the repair, and give way.
      seam.beforeCreate = (path) => {
        if (!path.includes(MARKER_INFIX)) return;
        seam.beforeCreate = undefined;
        holdLockAs(otherProcessId);
      };
      const markersWhileWaiting: string[][] = [];
      finishRepairWhenLookedAt(() => markersWhileWaiting.push(markers()));
      const open = vi.fn(() => 'opened');

      expect(withRegisteredOpener(dbPath, open)).toBe('opened');

      expect(open).toHaveBeenCalledTimes(1);
      expect(markersWhileWaiting).toEqual([[]]);
      expect(markers()).toEqual([]);
    });

    it('gives up when the repair outlasts the wait, without opening or leaving a marker', () => {
      holdLockAs(otherProcessId);
      const open = vi.fn();

      const failure = catchError(() => withRegisteredOpener(dbPath, open, SHORT_WAIT_MS));

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect(open).not.toHaveBeenCalled();
      expect(markers()).toEqual([]);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('removes the lock of a repair that died, so it does not outlive the crash', () => {
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      const open = vi.fn(() => 'opened');

      expect(withRegisteredOpener(dbPath, open)).toBe('opened');

      expect(open).toHaveBeenCalledTimes(1);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('reports a dead repair lock it cannot move aside, and does not open', () => {
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from === lockPath) throw fsError('EPERM', 'rename');
      };
      const open = vi.fn();

      const failure = catchError(() => withRegisteredOpener(dbPath, open, SHORT_WAIT_MS));

      expect((failure as NodeJS.ErrnoException).code).toBe('EPERM');
      expect(open).not.toHaveBeenCalled();
      expect(markers()).toEqual([]);
    });
  });

  describe('a repair', () => {
    let fingerprint: string | undefined;

    beforeEach(() => {
      fingerprint = writeCorruptSet(dbPath);
    });

    const repair = (waitMs = SHORT_WAIT_MS): string | undefined =>
      quarantineCorruptDatabase(dbPath, fingerprint, new Error('bad'), waitMs);

    function markerOf(processId: number, suffix = 'abc'): string {
      const marker = `${dbPath}${MARKER_INFIX}${processId}.${suffix}`;
      writeFileSync(marker, '');
      return marker;
    }

    it('changes nothing until the process that is opening the file is done', () => {
      const marker = markerOf(otherProcessId);
      const realKill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === otherProcessId) rmSync(marker, { force: true }); // its open ends meanwhile
        return realKill(pid, signal);
      }) as typeof process.kill);
      const markerPresentAtCopy: boolean[] = [];
      seam.beforeCopy = () => markerPresentAtCopy.push(existsSync(marker));

      const backup = repair(2_000);

      expect(backup).toBeDefined();
      expect(markerPresentAtCopy.length).toBeGreaterThan(0);
      expect(markerPresentAtCopy.every((present) => !present)).toBe(true);
    });

    it('gives up, naming the marker, while that process keeps opening, and changes nothing', () => {
      const marker = markerOf(otherProcessId);
      const before = snapshotDir(dir);

      const failure = catchError(() => repair());

      expect(failure).toBeInstanceOf(DatabaseLockedError);
      expect((failure as Error).message).toContain(marker);
      expect(backupNames(dir)).toEqual([]);
      expect(snapshotDir(dir)).toEqual(before);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('does not wait for the marker of a process that has died, and deletes it', () => {
      const marker = markerOf(deadProcessId());

      expect(repair()).toBeDefined();

      expect(existsSync(marker)).toBe(false);
    });

    it('does not wait for a marker of its own process, which runs one thing at a time', () => {
      const marker = markerOf(process.pid);

      expect(repair()).toBeDefined();

      expect(existsSync(marker)).toBe(true);
    });

    it('does not wait for files that only look like markers', () => {
      writeFileSync(`${dbPath}${MARKER_INFIX}abc`, '');
      writeFileSync(`${dbPath}${MARKER_INFIX}0.abc`, '');
      writeFileSync(`${dbPath}${MARKER_INFIX}-5.abc`, '');

      expect(repair()).toBeDefined();
    });
  });

  describe('the adapter', () => {
    it('leaves no marker and no lock behind after opening', async () => {
      seedDatabase(dbPath, { wal: true });

      (await BetterSqliteAdapter.create(dbPath)).close();

      expect(readdirSync(dir)).toEqual(['vault.db']);
    });

    it('waits for a repair in progress before it opens', async () => {
      seedDatabase(dbPath);
      holdLockAs(otherProcessId);
      const waited = vi.fn();
      finishRepairWhenLookedAt(waited);

      const adapter = await BetterSqliteAdapter.create(dbPath);
      adapter.close();

      expect(waited).toHaveBeenCalled();
    });

    it('clears the lock a dead repair left, when the next open does not need a repair', async () => {
      seedDatabase(dbPath);
      writeFileSync(lockPath, `${deadProcessId()}\n`);

      (await BetterSqliteAdapter.create(dbPath)).close();

      expect(existsSync(lockPath)).toBe(false);
      expect(backupNames(dir)).toEqual([]);
    });

    it('reports a dead repair lock it cannot move aside as a permission error', async () => {
      seedDatabase(dbPath);
      writeFileSync(lockPath, `${deadProcessId()}\n`);
      seam.beforeRename = (from) => {
        if (from === lockPath) throw fsError('EPERM', 'rename');
      };
      const before = snapshotDir(dir);

      const failure = await BetterSqliteAdapter.create(dbPath).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DatabasePermissionError);
      expect(snapshotDir(dir)).toEqual(before);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'opens read-only in a folder nothing can be created in, so needs no marker',
      async () => {
        seedDatabase(dbPath); // journal mode DELETE: a read-only open needs no other file
        chmodSync(dir, 0o555);

        try {
          const adapter = await BetterSqliteAdapter.create(dbPath, {
            readonly: true,
            walMode: false,
          });
          adapter.close();
        } finally {
          chmodSync(dir, 0o755);
        }

        expect(readdirSync(dir)).toEqual(['vault.db']);
      },
    );
  });
});
