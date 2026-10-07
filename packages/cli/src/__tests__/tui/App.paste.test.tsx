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
} from './harness.js';

const { exitMock, openInEditorMock } = vi.hoisted(() => ({
  exitMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

// Quit is asserted through the exit callback so the app stays mounted after a Ctrl+C byte.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

// A real editor must never start from a unit test.
vi.mock('../../tui/openInEditor.js', () => ({ openInEditor: openInEditorMock }));

const clipboardWrite = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('clipboardy', () => ({ default: { write: clipboardWrite } }));

const ASYNC_SETTLE_MS = 50;
const FROZEN_CLOCK_MS = 1_700_000_000_000;
// A terminal without bracketed paste sends clipboard text as is. Text that itself carries a marker
// pair (a copied terminal log, hostile clipboard text) makes Ink emit the pair's body as a paste
// and the bytes after it as keys, all in one stdin read. Every byte of it was pasted: a CR in it
// is not Enter and a Ctrl+F is not a favorite toggle, whether or not a line comes before the pair.
const MARKER_PAIR_THEN_KEYS = [
  {
    name: 'a line, the pair, a CR and a Ctrl+F',
    raw: `demo\n${PASTE_START}x${PASTE_END}\r\x06`,
    shown: 'demo x',
  },
  { name: 'the pair, a CR and a Ctrl+F', raw: `${PASTE_START}x${PASTE_END}\r\x06`, shown: 'x' },
  { name: 'the pair and a CR', raw: `${PASTE_START}x${PASTE_END}\r`, shown: 'x' },
  { name: 'the pair and a Ctrl+O', raw: `${PASTE_START}x${PASTE_END}\x0f`, shown: 'x' },
] as const;

const settle = () => new Promise((done) => setTimeout(done, ASYNC_SETTLE_MS));

function mountThree() {
  const vault = makeVault(['alpha', 'beta', 'gamma'].map((name) => makeEntry(name)));
  return { vault, mounted: mountApp(vault) };
}

function expectNothingActed(vault: ReturnType<typeof makeVault>): void {
  expect(vault.recordUsage).not.toHaveBeenCalled();
  expect(vault.toggleFavorite).not.toHaveBeenCalled();
  expect(clipboardWrite).not.toHaveBeenCalled();
  expect(openInEditorMock).not.toHaveBeenCalled();
}

function resetMocks(): void {
  vi.resetModules();
  exitMock.mockReset();
  openInEditorMock.mockReset();
  clipboardWrite.mockClear();
}

describe('App with a bracketed paste', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(resetMocks);

  afterEach(() => {
    cleanup();
  });

  it('inserts a bracketed multi-line paste as one line of text and acts on nothing', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write(`${PASTE_START}a\nb\nc${PASTE_END}`);

    await waitForFrame((f) => f.includes('> a b c'));
    expect(frame()).toContain('> a b c');
    expectNothingActed(vault);
    expect(exitMock).not.toHaveBeenCalled();
  });

  // One line break in a short read is a typed Enter when it comes as keys; the paste markers
  // alone must make it text. This is what Ink's paste channel adds over the raw-run heuristic.
  it('keeps a short two-line bracketed paste as text, where the same keys would press Enter', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write(`${PASTE_START}ab\ncd${PASTE_END}`);

    await waitForFrame((f) => f.includes('> ab cd'));
    expect(frame()).toContain('> ab cd');
    expectNothingActed(vault);
  });

  // A key handled inside Ink's input event has React's render queued before anything else; a key
  // held to the end of the read renders one microtask later, which shifts every timer the render
  // starts (the search debounce) behind the next keystroke.
  it('renders a typed letter on the next microtask, as a plain keystroke always did', async () => {
    const { mounted } = mountThree();
    const { frame, writeNow } = await mounted;

    writeNow('a');
    await Promise.resolve();

    expect(frame()).toContain('> a');
  });

  it('strips escape sequences inside a bracketed paste instead of typing them', async () => {
    const { mounted } = mountThree();
    const { write, waitForFrame } = await mounted;

    await write(`${PASTE_START}\x1b[31mred\x1b[0m${PASTE_END}`);

    await waitForFrame((f) => f.includes('> red'));
  });

  // Trimming is what the paste cleaner adds over flattening. The paste lands between two typed
  // letters, so a stray space at either edge of it would show up in the box.
  it('trims a bracketed paste: whitespace and line breaks at its edges are not typed', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;
    await write('qz');
    await write(KEYS.left);
    await waitForFrame((f) => f.includes('> qz'));

    await write(`${PASTE_START} \n\t a\n b \n${PASTE_END}`);

    await waitForFrame((f) => f.includes('> qa bz'));
    expect(queryShown(frame())).toBe('qa bz');
    expectNothingActed(vault);
  });

  it('types nothing for a bracketed paste of nothing but whitespace', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;
    await write('qz');
    await write(KEYS.left);
    await waitForFrame((f) => f.includes('> qz'));

    await write(`${PASTE_START} \n\t \r\n ${PASTE_END}`);
    await settle();

    expect(queryShown(frame())).toBe('qz');
    expectNothingActed(vault);
  });
});

// The boundary rule: a stdin read that carries a paste fires no entry action, whatever keys Ink
// delivers with it. Only a script or a terminal multiplexer puts keys in the same read as a paste,
// a person cannot. The clock is frozen so that the read right after a paste is provably its own.
describe(
  'App with keys in the same stdin read as a bracketed paste',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      resetMocks();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FROZEN_CLOCK_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
      cleanup();
    });

    for (const { name, raw, shown } of MARKER_PAIR_THEN_KEYS) {
      it(`inserts a raw read of ${name} as text and acts on nothing`, async () => {
        const { vault, mounted } = mountThree();
        const { frame, write, waitForFrame } = await mounted;

        await write(raw);

        await waitForFrame((f) => f.includes(`> ${shown}`));
        await settle();
        expect(queryShown(frame())).toBe(shown);
        expectNothingActed(vault);
        expect(exitMock).not.toHaveBeenCalled();
      });
    }

    it('does not toggle the favorite for a Ctrl+F that follows a bracketed paste in the same read', async () => {
      const { vault, mounted } = mountThree();
      const { frame, write, waitForFrame } = await mounted;

      await write(`${KEYS.down}${PASTE_START}demo${PASTE_END}${KEYS.ctrlF}`);

      await waitForFrame((f) => f.includes('> demo'));
      await settle();
      expect(queryShown(frame())).toBe('demo');
      expectNothingActed(vault);
    });

    it('types the printable keys that came in the same read as a bracketed paste, Enter dropped', async () => {
      const { vault, mounted } = mountThree();
      const { frame, write, waitForFrame } = await mounted;

      await write(`${PASTE_START}alpha${PASTE_END}bc${KEYS.enter}`);

      await waitForFrame((f) => f.includes('> alphabc'));
      await settle();
      expect(queryShown(frame())).toBe('alphabc');
      expectNothingActed(vault);
    });

    // A bracketed paste is one whole event: Ink holds a partial paste back until its end marker, so
    // nothing that follows it is a piece of it, and the window that joins raw pieces must not open.
    it('acts on an Enter in its own read right after a bracketed paste', async () => {
      const { vault, mounted } = mountThree();
      const { frame, write, waitForFrame } = await mounted;
      await write(`${PASTE_START}alpha${PASTE_END}`);
      await waitForFrame((f) => f.includes('> alpha'));

      await write(KEYS.enter);

      await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
      expect(vault.recordUsage).toHaveBeenCalledTimes(1);
      expect(queryShown(frame())).toBe('alpha');
    });
  },
);
