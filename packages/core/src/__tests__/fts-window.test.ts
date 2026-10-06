import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import {
  describeFailures,
  launchRaceWorkers,
  raceEntries,
  raceJob,
  stopRaceWorkers,
} from './reindex-race-support.js';

// A reader in another process polls the full-text table while this one reindexes, every row
// changed each time. The table is maintained inside the reindex transaction, row by row, so the
// reader sees the rows before or the rows after and never fewer. The failing version emptied the
// table and refilled it in two statements after its transaction had committed, on every command.

const ENTRY_COUNT = 40;
const REINDEX_CYCLES = 20;
const MAX_POLLS = 50_000;
const POLL_PAUSE_MS = 1;
const TEST_TIMEOUT_MS = 5 * 60_000;

describe('the full-text table while another process reindexes', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-fts-window-'));
    dbPath = join(tempDir, 'vault.db');
    const engine = await SqliteEngine.create(dbPath);
    engine.index(raceEntries(ENTRY_COUNT));
    engine.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it(
    `never has fewer rows than there are entries, over ${REINDEX_CYCLES} reindexes`,
    async () => {
      const stopFile = join(tempDir, 'stop');
      const reader = raceJob({
        role: 'reader',
        workerId: 'reader',
        dbPath,
        rounds: MAX_POLLS,
        pauseMs: POLL_PAUSE_MS,
        stopFile,
      });
      const reindexer = raceJob({
        role: 'reindexer',
        workerId: 'reindexer',
        dbPath,
        rounds: REINDEX_CYCLES,
        entryCount: ENTRY_COUNT,
        varyContent: true,
      });

      const workers = await launchRaceWorkers([reader, reindexer], tempDir);
      let reports;
      try {
        const reindexReport = await workers[1]!.report;
        writeFileSync(stopFile, '');
        reports = [await workers[0]!.report, reindexReport];
      } finally {
        stopRaceWorkers(workers);
      }

      expect(describeFailures(reports)).toEqual([]);
      const [readerReport, reindexReport] = reports;
      expect(reindexReport!.cycles).toBe(REINDEX_CYCLES);
      expect(readerReport!.reads.polls).toBeGreaterThan(0);
      expect(readerReport!.reads.ftsEmptySeen).toBe(0);
      expect(readerReport!.reads.minFtsRows).toBe(ENTRY_COUNT);
      expect(readerReport!.reads.minEntries).toBe(ENTRY_COUNT);
    },
    TEST_TIMEOUT_MS,
  );
});
