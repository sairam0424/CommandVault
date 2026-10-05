import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { KEYS, TEST_TIMEOUT_MS, makeEntry, makeVault, mountApp } from './harness.js';

const { exitMock } = vi.hoisted(() => ({ exitMock: vi.fn() }));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

const clipboardWrite = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('clipboardy', () => ({ default: { write: clipboardWrite } }));

const PREVIEW_MARKER = 'preview-marker-text';
const TERMINAL_ROWS = 30;
const WIDE_COLUMNS = 100;
const NO_PREVIEW_COLUMNS = 70;
const BANNER_COLUMNS = 50;
const MIN_USABLE_COLUMNS = 60;
const WIDEST_CHECKED_COLUMNS = 140;
// The preview pane needs this many columns; narrower terminals show the list alone.
const NO_PREVIEW_BELOW_COLUMNS = 80;

const mountWithPreview = () =>
  mountApp(makeVault([makeEntry('alpha', { content: PREVIEW_MARKER })]));

describe('App layout', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
    clipboardWrite.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('resize', () => {
    it('drops the preview when the terminal narrows and brings it back when it widens', async () => {
      const { resize, waitForFrame } = await mountWithPreview();
      await waitForFrame((f) => f.includes(PREVIEW_MARKER));

      await resize(NO_PREVIEW_COLUMNS, TERMINAL_ROWS);
      await waitForFrame((f) => !f.includes(PREVIEW_MARKER) && f.includes('alpha'));

      await resize(WIDE_COLUMNS, TERMINAL_ROWS);
      await waitForFrame((f) => f.includes(PREVIEW_MARKER));
    });

    it('swaps the UI for an accurate banner below the minimum width and back again', async () => {
      const { resize, waitForFrame, frame } = await mountWithPreview();

      await resize(BANNER_COLUMNS, TERMINAL_ROWS);
      await waitForFrame((f) => f.includes('too narrow'));
      expect(frame()).toContain(`${BANNER_COLUMNS} cols`);
      expect(frame()).toContain(`${MIN_USABLE_COLUMNS}`);
      expect(frame()).toContain('^C');

      await resize(MIN_USABLE_COLUMNS, TERMINAL_ROWS);
      await waitForFrame((f) => !f.includes('too narrow') && f.includes('alpha'));
    });

    it('does not act on Enter or Ctrl+F while the banner hides the list', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { resize, write, waitForFrame } = await mountApp(vault);
      await resize(BANNER_COLUMNS, TERMINAL_ROWS);
      await waitForFrame((f) => f.includes('too narrow'));

      await write(`${KEYS.enter}${KEYS.ctrlF}`);
      await new Promise((done) => setTimeout(done, 50));

      expect(vault.recordUsage).not.toHaveBeenCalled();
      expect(vault.toggleFavorite).not.toHaveBeenCalled();
    });

    it('still quits on Ctrl+C while the banner shows', async () => {
      const { resize, write, waitForFrame } = await mountWithPreview();
      await resize(BANNER_COLUMNS, TERMINAL_ROWS);
      await waitForFrame((f) => f.includes('too narrow'));

      await write(KEYS.ctrlC);

      await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1));
    });
  });

  describe('hint bar', () => {
    it('fits on one line and keeps the quit hint at every width the UI supports', async () => {
      const { resize, frame } = await mountWithPreview();

      for (let columns = MIN_USABLE_COLUMNS; columns <= WIDEST_CHECKED_COLUMNS; columns += 1) {
        await resize(columns, TERMINAL_ROWS);
        await vi.waitFor(() => expect(frame()).not.toContain('too narrow'));

        const lines = frame().split('\n');
        const barTop = lines.map((l) => l.startsWith('┌')).lastIndexOf(true);
        // top border, one hint line, bottom border: a wrapped bar would add rows
        expect(lines.length - 1 - barTop, `height of the hint bar at ${columns} columns`).toBe(2);
        expect(lines[barTop + 1], `hint bar at ${columns} columns`).toContain('^C Quit');
        if (columns < NO_PREVIEW_BELOW_COLUMNS) {
          // no preview pane is drawn here, so there is nothing for PgUp/PgDn to scroll
          expect(lines[barTop + 1], `hint bar at ${columns} columns`).not.toContain('PgUp');
        }
        for (const line of lines) {
          expect(line.length, `line width at ${columns} columns`).toBeLessThanOrEqual(columns);
        }
      }
    });

    it('cuts a long status message to the width instead of wrapping the bar', async () => {
      const longName = 'a-very-long-entry-name-'.repeat(6);
      const { resize, write, frame, waitForFrame } = await mountApp(
        makeVault([makeEntry(longName)]),
      );
      await resize(MIN_USABLE_COLUMNS, TERMINAL_ROWS);

      await write(KEYS.ctrlF);

      await waitForFrame((f) => f.includes('Added to favorites'));
      const lines = frame().split('\n');
      const barTop = lines.map((l) => l.startsWith('┌')).lastIndexOf(true);
      expect(lines.length - 1 - barTop).toBe(2);
      expect(lines[barTop + 1]).toContain('…');
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(MIN_USABLE_COLUMNS);
    });

    it('shows the full labels when there is room', async () => {
      const { frame, waitForFrame } = await mountWithPreview();

      await waitForFrame((f) => f.includes('^C Quit'));

      expect(frame()).toContain('^O Open');
      expect(frame()).toContain('^F');
      expect(frame()).toContain('PgUp/PgDn');
    });
  });
});
