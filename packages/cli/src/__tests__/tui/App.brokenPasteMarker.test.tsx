import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import {
  KEYS,
  PASTE_END,
  PASTE_START,
  TEST_TIMEOUT_MS,
  makeEntry,
  makeVault,
  mountApp,
  queryShown,
  type MountedApp,
} from './harness.js';
import { PASTE_MIN_LENGTH } from '../../tui/keys.js';
import { PASTE_BURST_MS, PASTE_OPEN_IDLE_MS } from '../../tui/pasteReads.js';

const { exitMock, openInEditorMock } = vi.hoisted(() => ({
  exitMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

// Quit is asserted through the exit callback so the app stays mounted after an Esc or a Ctrl+C.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

// A real editor must never start from a unit test.
vi.mock('../../tui/openInEditor.js', () => ({ openInEditor: openInEditorMock }));

const clipboardWrite = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('clipboardy', () => ({ default: { write: clipboardWrite } }));

// Ink's input parser holds `\e[200` and a whole start marker back for its paste channel, but a
// pending `\e`, `\e[`, `\e[2` or `\e[20` is flushed to the key handler after 20 ms as a key or as
// literal text (input-parser.js hasPendingEscape). These are the byte counts that reach it first.
const FLUSHED_AS_TEXT = [3, 4];
const FLUSHED_AS_KEY_OR_BRACKET = [
  // A lone ESC is the Escape key to Ink: it clears the typed query, a residue the test documents.
  { split: 1, shown: 'alpha' },
  // A lone `[` is a typed bracket and stays in the box; the marker's rest must not.
  { split: 2, shown: 'q[alpha' },
] as const;
const FROZEN_CLOCK_MS = 1_700_000_000_000;
// Wide enough to show a long query whole, so its text can be read off the frame.
const WIDE_COLUMNS = 300;
const TALL_ROWS = 40;
const LONG_PIECE = 'a'.repeat(PASTE_MIN_LENGTH + 6);
const SHORT_PIECE = 'b'.repeat(10);
function expectNothingActed(vault: ReturnType<typeof makeVault>): void {
  expect(vault.recordUsage).not.toHaveBeenCalled();
  expect(vault.toggleFavorite).not.toHaveBeenCalled();
  expect(clipboardWrite).not.toHaveBeenCalled();
  expect(openInEditorMock).not.toHaveBeenCalled();
}

/**
 * Writes the first bytes of a start marker as their own stdin read and fires the flush Ink
 * schedules for them, exactly as when the rest of the marker arrives more than 20 ms later.
 * The timer count proves the flush was pending: without it Ink would join the two reads into a
 * whole marker and the test would pass for the wrong reason.
 */
async function writeMarkerPiece(write: MountedApp['write'], piece: string): Promise<void> {
  const timersBefore = vi.getTimerCount();
  await write(piece);
  expect(vi.getTimerCount(), 'Ink scheduled its pending-escape flush').toBeGreaterThan(
    timersBefore,
  );
  vi.runOnlyPendingTimers();
}

// Ink's flush is a timer and the window that joins the pieces of a paste is wall-clock time; both
// faked, the flush fires on demand and the window never closes on its own, whatever the load.
describe(
  'App with a bracketed paste whose start marker Ink broke',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      vi.resetModules();
      exitMock.mockReset();
      openInEditorMock.mockReset();
      clipboardWrite.mockClear();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(FROZEN_CLOCK_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
      cleanup();
    });

    async function mountWide() {
      const vault = makeVault(['alpha', 'beta', 'gamma'].map((name) => makeEntry(name)));
      const app = await mountApp(vault);
      await app.resize(WIDE_COLUMNS, TALL_ROWS);
      return { vault, ...app };
    }

    for (const split of FLUSHED_AS_TEXT) {
      const piece = PASTE_START.slice(0, split);
      it(`inserts the body as text after Ink flushed "${piece.slice(1)}", and the Enter after it acts`, async () => {
        const { vault, frame, write, waitForFrame } = await mountWide();

        await writeMarkerPiece(write, piece);
        await write(`${PASTE_START.slice(split)}alpha\n${PASTE_END}`);

        await waitForFrame((f) => f.includes('> alpha'));
        expect(queryShown(frame())).toBe('alpha');
        expectNothingActed(vault);

        // The end marker closes the paste: with the clock frozen, only that lets this Enter act.
        await write(KEYS.enter);

        await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
        expect(vault.recordUsage).toHaveBeenCalledTimes(1);
      });
    }

    for (const { split, shown } of FLUSHED_AS_KEY_OR_BRACKET) {
      const piece = PASTE_START.slice(0, split);
      it(`inserts the body as text after Ink flushed ${JSON.stringify(piece)} on its own`, async () => {
        const { vault, frame, write, waitForFrame } = await mountWide();
        await write('q');
        await waitForFrame((f) => f.includes('> q'));

        await writeMarkerPiece(write, piece);
        await write(`${PASTE_START.slice(split)}alpha\n${PASTE_END}`);

        await waitForFrame((f) => f.includes('alpha'));
        expect(queryShown(frame())).toBe(shown);
        expectNothingActed(vault);
        expect(exitMock).not.toHaveBeenCalled();
      });
    }

    it('joins the pieces of a long body that follows a broken start marker', async () => {
      const { vault, frame, write, waitForFrame } = await mountWide();

      await writeMarkerPiece(write, '\x1b[20');
      await write(`0~${LONG_PIECE}\n`);
      await write(`${SHORT_PIECE}\n${PASTE_END}`);

      await waitForFrame((f) => f.includes(`> ${LONG_PIECE} ${SHORT_PIECE}`));
      expect(queryShown(frame())).toBe(`${LONG_PIECE} ${SHORT_PIECE}`);
      expectNothingActed(vault);
    });

    // The keys after the end marker arrived in the same stdin read as the paste, which no person
    // manages: a printable one is text, an Enter is nothing, and the paste closes all the same.
    it('types the printable key after the end marker in the same read and acts on none', async () => {
      const { vault, frame, write, waitForFrame } = await mountWide();

      await writeMarkerPiece(write, '\x1b[20');
      await write(`0~alpha\n${PASTE_END}x${KEYS.enter}`);

      await waitForFrame((f) => f.includes('> alpha x'));
      expect(queryShown(frame())).toBe('alpha x');
      expectNothingActed(vault);

      // The end marker closed the paste: an Enter in its own read acts again.
      await write(KEYS.enter);

      await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
      expect(vault.recordUsage).toHaveBeenCalledTimes(1);
    });

    // A slow link hands the body over in pieces further apart than the raw burst window. The paste
    // is bracketed: its bytes are text up to the end marker, however long they take to arrive.
    it('keeps a body piece that comes after the burst window as text, up to the end marker', async () => {
      const { vault, frame, write, waitForFrame } = await mountWide();

      await writeMarkerPiece(write, '\x1b[20');
      await write('0~alpha\n');
      await waitForFrame((f) => f.includes('> alpha'));

      vi.setSystemTime(Date.now() + PASTE_BURST_MS + 1);
      await write('beta\n');
      await waitForFrame((f) => f.includes('> alpha beta'));
      // A piece with no line break in it would pass for a typed word; it is still the paste.
      vi.setSystemTime(Date.now() + PASTE_BURST_MS + 1);
      await write('gamma');

      await waitForFrame((f) => f.includes('> alpha beta gamma'));
      expect(queryShown(frame())).toBe('alpha beta gamma');
      expectNothingActed(vault);

      // The end marker, not the clock, closes the paste: only then does an Enter act again.
      vi.setSystemTime(Date.now() + PASTE_BURST_MS + 1);
      await write(PASTE_END);
      await write(KEYS.enter);

      await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
      expect(vault.recordUsage).toHaveBeenCalledTimes(1);
    });

    // A start marker pasted raw or typed has no end marker coming: keys must not stay swallowed.
    it('closes a paste whose end marker never comes once the idle ceiling has passed', async () => {
      const { vault, frame, write, waitForFrame } = await mountWide();

      await writeMarkerPiece(write, '\x1b[20');
      await write('0~alpha\n');
      await waitForFrame((f) => f.includes('> alpha'));

      vi.setSystemTime(Date.now() + PASTE_OPEN_IDLE_MS + 1);
      // A letter and an Enter in one read: held to the end of the read, so the read is judged as
      // a whole, and that judgement must now be keys.
      await write(`x${KEYS.enter}`);

      await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
      expect(vault.recordUsage).toHaveBeenCalledTimes(1);
      // The keys were applied at the end of the read; Ink renders them on a throttled timer.
      await waitForFrame((f) => f.includes('> alphax'));
      expect(queryShown(frame())).toBe('alphax');
    });

    it('types a flushed "[20" that no marker follows, and the key after it, losing nothing', async () => {
      const { vault, frame, write, waitForFrame } = await mountWide();

      await writeMarkerPiece(write, '\x1b[20');
      await write('x');

      await waitForFrame((f) => f.includes('> [20x'));
      expect(queryShown(frame())).toBe('[20x');
      expectNothingActed(vault);
    });

    it('still quits on a Ctrl+C in its own read while a marker piece is held', async () => {
      const { write } = await mountWide();

      await writeMarkerPiece(write, '\x1b[20');
      await write(KEYS.ctrlC);

      await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1));
    });
  },
);
