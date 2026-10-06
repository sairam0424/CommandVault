import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../indexer/database-adapter.js';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { instrumentAdapter } from './adapter-instrument.js';
import { raceEntries, raceEntryId } from './reindex-race-support.js';

// A reindex writes the rows that changed and nothing else, on both backends: a second scan of the
// same files costs no write at all (no WAL growth, no file save), and the full-text table is never
// emptied and refilled. The failing version rewrote every row with INSERT OR REPLACE on every
// command and then rebuilt the whole full-text table.

type Backend = 'better-sqlite3' | 'sql.js';

const ENTRY_COUNT = 10;
const CHANGED_INDEX = 3;
const FRESH_WORD = 'freshword';

const scenario = vi.hoisted(() => ({
  backend: 'better-sqlite3' as Backend,
  adapter: undefined as DatabaseAdapter | undefined,
  log: [] as string[],
}));

vi.mock('../indexer/database-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../indexer/database-factory.js')>();
  const { SqlJsAdapter } = await import('../indexer/sqljs-adapter.js');
  const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
  return {
    ...original,
    createDatabaseAdapter: async (...args: Parameters<typeof original.createDatabaseAdapter>) => {
      const adapter =
        scenario.backend === 'sql.js'
          ? await SqlJsAdapter.create(...args)
          : await original.createDatabaseAdapter(...args);
      scenario.adapter = adapter;
      return instrumentAdapter(adapter, {
        beforeExecute: (sql) => scenario.log.push(`execute ${normalize(sql)}`),
        beforeQuery: (sql) => scenario.log.push(`query ${normalize(sql)}`),
        onTransaction: (options) => scenario.log.push(`transaction ${options?.mode ?? 'deferred'}`),
      });
    },
  };
});

function adapter(): DatabaseAdapter {
  if (!scenario.adapter) throw new Error('no adapter was created');
  return scenario.adapter;
}

function totalChanges(): number {
  return adapter().queryOne<{ n: number }>('SELECT total_changes() AS n')!.n;
}

function count(sql: string, params?: Record<string, unknown>): number {
  return adapter().queryOne<{ n: number }>(sql, params)!.n;
}

function executed(pattern: RegExp): string[] {
  return scenario.log.filter((line) => line.startsWith('execute ') && pattern.test(line));
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.each<Backend>(['better-sqlite3', 'sql.js'])('a reindex on %s', (backend) => {
  let tempDir: string;
  let dbPath: string;
  let engine: SqliteEngine;
  const hasFts = backend === 'better-sqlite3';

  beforeEach(async () => {
    scenario.backend = backend;
    tempDir = await mkdtemp(join(tmpdir(), 'cv-reindex-noop-'));
    dbPath = join(tempDir, 'vault.db');
    engine = await SqliteEngine.create(dbPath);
    engine.index(raceEntries(ENTRY_COUNT));
    scenario.log = [];
  });

  afterEach(async () => {
    engine.close();
    scenario.adapter = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes nothing when no entry changed', () => {
    const changesBefore = totalChanges();
    const probe = hasFts ? new Database(dbPath) : undefined;
    const versionBefore = probe?.pragma('data_version', { simple: true });

    engine.index(raceEntries(ENTRY_COUNT));

    expect(totalChanges() - changesBefore).toBe(0);
    expect(executed(/./)).toEqual([]);
    expect(probe?.pragma('data_version', { simple: true })).toBe(versionBefore);
    probe?.close();
  });

  it('never empties the full-text table nor replaces whole rows', () => {
    engine.index(raceEntries(ENTRY_COUNT, 1));

    expect(scenario.log.filter((line) => /INSERT OR REPLACE/i.test(line))).toEqual([]);
    expect(scenario.log.filter((line) => /DELETE FROM entries_fts(?! WHERE)/i.test(line))).toEqual(
      [],
    );
  });

  it('writes exactly the entry whose content changed, with its tags and full-text row', () => {
    const entries = raceEntries(ENTRY_COUNT);
    const changed = { ...entries[CHANGED_INDEX]!, content: `${FRESH_WORD} and nothing else` };
    const changesBefore = totalChanges();

    engine.index(entries.map((entry, index) => (index === CHANGED_INDEX ? changed : entry)));

    expect(engine.getEntry(changed.id)?.content).toBe(changed.content);
    expect(executed(/DELETE FROM entry_tags WHERE entry_id/)).toHaveLength(1);
    expect(executed(/INSERT OR IGNORE INTO entry_tags/)).toHaveLength(changed.tags.length);
    // The row, its old tags out, its tags in; the full-text table's shadow rows come on top.
    const rowWrites = 1 + 2 * changed.tags.length;
    if (hasFts) {
      expect(totalChanges() - changesBefore).toBeGreaterThan(rowWrites);
      expect(executed(/DELETE FROM entries_fts WHERE id IN/)).toHaveLength(1);
      expect(executed(/INSERT INTO entries_fts/)).toHaveLength(1);
      expect(
        count('SELECT count(*) AS n FROM entries_fts WHERE id = $id', { $id: changed.id }),
      ).toBe(1);
    } else {
      expect(totalChanges() - changesBefore).toBe(rowWrites);
    }
    expect(engine.search({ query: FRESH_WORD, limit: 5 }).map((r) => r.entry.id)).toEqual([
      changed.id,
    ]);
  });

  it('removes the row, the tags and the full-text row of an entry the scan no longer has', () => {
    const removedId = raceEntryId(ENTRY_COUNT - 1);

    engine.index(raceEntries(ENTRY_COUNT - 1));

    expect(engine.getEntry(removedId)).toBeUndefined();
    expect(
      count('SELECT count(*) AS n FROM entry_tags WHERE entry_id = $id', { $id: removedId }),
    ).toBe(0);
    if (hasFts) {
      expect(
        count('SELECT count(*) AS n FROM entries_fts WHERE id = $id', { $id: removedId }),
      ).toBe(0);
    }
  });

  it('keeps a favorite and uses recorded between two scans, changed content or not', () => {
    const id = raceEntryId(CHANGED_INDEX);
    adapter().execute('UPDATE entries SET favorite = 1, usage_count = 7 WHERE id = $id', {
      $id: id,
    });

    engine.index(raceEntries(ENTRY_COUNT));
    expect(engine.getEntry(id)).toMatchObject({ favorite: true, usageCount: 7 });

    engine.index(raceEntries(ENTRY_COUNT, 1));
    expect(engine.getEntry(id)).toMatchObject({ favorite: true, usageCount: 7 });
  });

  it('leaves the file byte for byte as it was after a scan that changed nothing', async () => {
    engine.close();
    const bytesBefore = sha256(dbPath);

    engine = await SqliteEngine.create(dbPath);
    engine.index(raceEntries(ENTRY_COUNT));
    engine.close();

    expect(sha256(dbPath)).toBe(bytesBefore);
    engine = await SqliteEngine.create(dbPath);
  });
});
