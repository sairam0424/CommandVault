import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import type { EntrySource, EntryType, VaultEntry } from '@commandvault/core';
import {
  KEYS,
  POLL_TIMEOUT_MS,
  TEST_TIMEOUT_MS,
  makeEntry,
  makeVault,
  mountApp,
  type MountedApp,
} from './harness.js';

const { exitMock } = vi.hoisted(() => ({ exitMock: vi.fn() }));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

vi.mock('clipboardy', () => ({ default: { write: vi.fn().mockResolvedValue(undefined) } }));

const SWEEP_TIMEOUT_MS = 120_000;
const SMALLEST_ROWS = 24;
const LARGEST_ROWS = 60;
const COLUMN_WIDTHS = [60, 79, 80, 100, 140];
const NO_PREVIEW_BELOW_COLUMNS = 80;
const TYPES: readonly EntryType[] = ['skill', 'agent', 'command', 'rule', 'hook'];
const SOURCES: readonly EntrySource[] = ['custom', 'gstack', 'community', 'superpowers'];

// Long names, long descriptions and long content lines are what tempt a layout to wrap and overflow.
function crowdedEntries(count: number): VaultEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeEntry(`entry-${i}-${'name-'.repeat(12)}`, {
      type: TYPES[i % TYPES.length],
      source: SOURCES[i % SOURCES.length],
      description: `description ${i} ${'words '.repeat(40)}`,
      favorite: i % 3 === 0,
      usageCount: i % 4,
      filePath: `/fake/${'nested/'.repeat(10)}entry-${i}.md`,
      content: Array.from(
        { length: 120 },
        (_, line) => `line ${line} ${'wide text with 日本語 and emoji 🚀 '.repeat(6)}`,
      ).join('\n'),
    }),
  );
}

const lineCount = (frame: string): number => frame.split('\n').length;

// A resize renders on a later turn of the event loop, and a loaded machine can be slow to get
// there, so wait until the frame for the new size is the one on screen.
async function expectFrameFits(app: MountedApp, columns: number, rows: number): Promise<void> {
  await app.resize(columns, rows);
  await vi.waitFor(
    () => {
      const drawn = app.frame();
      expect(lineCount(drawn), `rows drawn at ${columns}x${rows}\n${drawn}`).toBe(rows);
      for (const line of drawn.split('\n')) {
        expect(line.length, `line width at ${columns}x${rows}`).toBeLessThanOrEqual(columns);
      }
    },
    { timeout: POLL_TIMEOUT_MS, interval: 10 },
  );
}

describe('App frame', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // 185 resizes of wide-character text take about 30 s on a loaded machine, the shared timeout.
  it(
    'fills the terminal exactly, at every height from 24 to 60 rows and every supported width',
    { timeout: SWEEP_TIMEOUT_MS },
    async () => {
      const app = await mountApp(makeVault(crowdedEntries(40)));

      for (let rows = SMALLEST_ROWS; rows <= LARGEST_ROWS; rows += 1) {
        for (const columns of COLUMN_WIDTHS) await expectFrameFits(app, columns, rows);
      }
    },
  );

  it('fits the terminal when nothing matches the query', async () => {
    const app = await mountApp(makeVault([]));

    for (const rows of [SMALLEST_ROWS, 30, LARGEST_ROWS]) {
      for (const columns of COLUMN_WIDTHS) await expectFrameFits(app, columns, rows);
    }
  });

  it('fits the terminal when a long status message is showing', async () => {
    const app = await mountApp(makeVault(crowdedEntries(3)));
    await expectFrameFits(app, NO_PREVIEW_BELOW_COLUMNS, SMALLEST_ROWS);

    await app.write(KEYS.ctrlF);

    await app.waitForFrame((f) => f.includes('Added to favorites'));
    expect(lineCount(app.frame())).toBe(SMALLEST_ROWS);
  });

  it('keeps the search box on one row when the query is wider than the box', async () => {
    const app = await mountApp(makeVault(crowdedEntries(3)));
    for (const columns of [60, 80, 140]) {
      await expectFrameFits(app, columns, SMALLEST_ROWS);
      const query = `${'a'.repeat(150)}TAIL`;

      await app.write(query);
      await app.waitForFrame((f) => f.includes('TAIL'));

      expect(lineCount(app.frame()), `rows drawn at ${columns}\n${app.frame()}`).toBe(
        SMALLEST_ROWS,
      );
      expect(app.frame().split('\n')[0]).toMatch(/^┌─+┐$/);
      await app.write('\x1b');
    }
  });

  it('keeps the cursor in view when it moves to the start of a long query', async () => {
    const app = await mountApp(makeVault(crowdedEntries(3)), { columns: 80, rows: SMALLEST_ROWS });

    await app.write(`HEAD${'b'.repeat(150)}`);
    for (let i = 0; i < 154; i += 1) await app.write(KEYS.left);

    expect(lineCount(app.frame())).toBe(SMALLEST_ROWS);
    expect(app.frame().split('\n')[1]).toContain('> HEAD');
  });

  it('keeps the status bar on one row for wide characters and line breaks in a name', async () => {
    for (const name of ['部'.repeat(40), 'one\ntwo', '🚀'.repeat(30), `${'x'.repeat(100)}\nend`]) {
      const app = await mountApp(makeVault([makeEntry(name)]), {
        columns: 80,
        rows: SMALLEST_ROWS,
      });

      await app.write(KEYS.ctrlF);

      await app.waitForFrame((f) => f.includes('Added to favorites'));
      expect(lineCount(app.frame()), `name ${JSON.stringify(name)}\n${app.frame()}`).toBe(
        SMALLEST_ROWS,
      );
      cleanup();
    }
  });

  it('keeps the frame the same height while the user types and pages', async () => {
    const app = await mountApp(
      makeVault(crowdedEntries(40), ({ query }) => crowdedEntries(40).slice(0, query.length)),
    );
    const { write, frame, waitForFrame } = app;
    await expectFrameFits(app, 100, SMALLEST_ROWS);

    await write('abcde');
    await waitForFrame((f) => f.includes('entry-4'));
    expect(lineCount(frame())).toBe(SMALLEST_ROWS);

    await write(KEYS.pageDown);
    await write(KEYS.down);
    expect(lineCount(frame())).toBe(SMALLEST_ROWS);
  });

  it('has no filter bar, and Tab changes nothing on screen', async () => {
    const { write, frame } = await mountApp(makeVault(crowdedEntries(3)));
    const before = frame();
    expect(before).not.toMatch(/Filter|Type:|Source:/);

    await write('\t');

    expect(frame()).toBe(before);
    expect(lineCount(frame())).toBe(lineCount(before));
  });
});
