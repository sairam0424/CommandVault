import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import { withDatabase, withReadonlyDatabase } from './migration-fixtures.js';
import { raceEntries, raceEntryId } from './reindex-race-support.js';

// Another process toggles a favorite and records uses in the instant before this one's reindex
// transaction begins. Every CLI command reindexes, so this is `vault favorite x` running beside
// `vault list`. The hook fires before the real BEGIN (adapter-instrument.ts), so the second handle
// never waits for a lock; what it wrote has to be there when the reindex is done. The failing
// version read favorite and usage_count of every row before its transaction and wrote the stale
// values back with INSERT OR REPLACE, on every command, changed entries or not.

const ENTRY_COUNT = 12;
const TARGET_INDEX = 5;
const OTHER_INDEX = 9;
const USES_BY_OTHER_PROCESS = 5;

const scenario = vi.hoisted(() => ({
  armed: false,
  dbPath: '',
  targetId: '',
  /** Mode of every transaction the engine started while a test watched, armed or not. */
  modes: [] as Array<string | undefined>,
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) =>
      instrumentAdapter(await original.createDatabaseAdapter(...args), {
        onTransaction: (options) => {
          scenario.modes.push(options?.mode);
          if (!scenario.armed) return;
          scenario.armed = false;
          withDatabase(scenario.dbPath, (db) =>
            db
              .prepare(
                `UPDATE entries SET favorite = 1 - favorite, usage_count = usage_count + ?
                 WHERE id = ?`,
              )
              .run(USES_BY_OTHER_PROCESS, scenario.targetId),
          );
        },
      }),
  };
});

function userState(dbPath: string, id: string): { favorite: number; usage_count: number } {
  return withReadonlyDatabase(
    dbPath,
    (db) =>
      db.prepare('SELECT favorite, usage_count FROM entries WHERE id = ?').get(id) as {
        favorite: number;
        usage_count: number;
      },
  );
}

/** The scan with one other entry's content changed: a reindex that has something to write. */
function scanWithAnotherChange(stamp: number): ReturnType<typeof raceEntries> {
  const changed = raceEntries(ENTRY_COUNT, stamp);
  return raceEntries(ENTRY_COUNT).map((entry, index) =>
    index === OTHER_INDEX ? changed[index]! : entry,
  );
}

describe('a favorite toggled and uses recorded by another process as a reindex begins', () => {
  let tempDir: string;
  let dbPath: string;
  let engine: SqliteEngine;
  const targetId = raceEntryId(TARGET_INDEX);
  const otherState = { favorite: 1, usage_count: USES_BY_OTHER_PROCESS };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-reindex-seam-'));
    dbPath = join(tempDir, 'vault.db');
    engine = await SqliteEngine.create(dbPath);
    engine.index(raceEntries(ENTRY_COUNT));
    scenario.dbPath = dbPath;
    scenario.targetId = targetId;
    scenario.modes = [];
  });

  afterEach(async () => {
    scenario.armed = false;
    engine.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('are still there after a reindex in which another entry changed', () => {
    scenario.armed = true;

    engine.index(scanWithAnotherChange(1));

    expect(userState(dbPath, targetId)).toEqual(otherState);
    expect(engine.getEntry(targetId)).toMatchObject({
      favorite: true,
      usageCount: USES_BY_OTHER_PROCESS,
    });
  });

  it('are still there after a reindex that changed the content of that very entry', () => {
    const changed = raceEntries(ENTRY_COUNT, 1);
    scenario.armed = true;

    engine.index(changed);

    expect(engine.getEntry(targetId)?.content).toBe(changed[TARGET_INDEX]!.content);
    expect(userState(dbPath, targetId)).toEqual(otherState);
  });

  it('are still there when only that entry is offered as changed', () => {
    const changed = raceEntries(ENTRY_COUNT, 2);
    scenario.armed = true;

    engine.index(changed, new Set([targetId]));

    expect(engine.getEntry(targetId)?.content).toBe(changed[TARGET_INDEX]!.content);
    expect(userState(dbPath, targetId)).toEqual(otherState);
  });

  it('cannot slip in later: the reindex takes the write lock the moment it begins', () => {
    scenario.armed = true;

    engine.index(scanWithAnotherChange(1));

    // A deferred transaction would read before another writer commits and then fail or clobber.
    expect(scenario.modes).toEqual(['immediate']);
  });

  it('cannot be in the way at all when the scan changed nothing: no write lock is taken', () => {
    engine.index(raceEntries(ENTRY_COUNT));

    expect(scenario.modes).toEqual([]);
  });
});
