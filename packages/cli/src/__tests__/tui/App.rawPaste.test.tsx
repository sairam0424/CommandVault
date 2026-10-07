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
import { PASTE_MIN_LENGTH } from '../../tui/keys.js';
import { PASTE_BURST_MS } from '../../tui/hooks/useKeyEvents.js';

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

const PASTED_LINES = 150;
const RANDOM_BYTES = 4096;
const RANDOM_SEEDS = [1, 2, 3];
// Wide enough to show a 200-character query whole, so its length can be read off the frame.
const WIDE_COLUMNS = 300;
const TALL_ROWS = 40;
const ASYNC_SETTLE_MS = 50;
// A raw paste of coloured text: Ink splits the read at each escape sequence, so the short first
// line reaches the key handler as its own event, before anything shows the read is a paste.
const COLOURED_PASTE = 'demo\n\x1b[32mx\x1b[0m\nb\nc\n';
// Pieces of one raw paste as a pty hands them over: the first is longer than any typed read,
// the second is short and would pass for typed keys on its own.
const LONG_PIECE = 'a'.repeat(PASTE_MIN_LENGTH + 6);
const SHORT_PIECE = 'b'.repeat(10);
const FROZEN_CLOCK_MS = 1_700_000_000_000;
// Raw pastes holding escape sequences Ink's key parser does not resolve. Ink strips the ESC and
// hands the key handler the tail ("[33m", "[1m", "]"), which must never be typed. `\x1b[32m` and
// `\x1b[0m` are not here: Ink happens to read them as modified keys and they vanish on their own.
const UNRESOLVED_SEQUENCE_PASTES = [
  {
    name: '16-colour yellow',
    raw: 'demo\n\x1b[33myellow\x1b[0m\nb\nc\n',
    shown: 'demo yellow b c',
  },
  {
    name: 'bold on the first line',
    raw: '\x1b[1mBold\x1b[0m\nline2\nline3\n',
    shown: 'Bold line2 line3',
  },
  {
    name: '256-colour',
    raw: 'demo\n\x1b[38;5;214morange\x1b[0m\nb\nc\n',
    shown: 'demo orange b c',
  },
  {
    name: 'grep output: bold red plus erase-to-end',
    raw: 'demo\n\x1b[1mbold\x1b[m\n\x1b[01;31m\x1b[Kmatch\x1b[m\x1b[K\nfourth\n',
    shown: 'demo bold match fourth',
  },
  {
    name: 'OSC window title first',
    raw: '\x1b]0;title\x07demo\nline2\nline3\n',
    shown: 'demo line2 line3',
  },
  {
    name: 'OSC 8 hyperlink',
    raw: '\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\\nline2\nline3\n',
    shown: 'link line2 line3',
  },
] as const;

const pastedText = Array.from(
  { length: PASTED_LINES },
  (_, i) => `def function_${i + 1}(arg): return arg * ${i + 1}  # some comment\n`,
).join('');

// A fixed pseudo-random byte string (glibc LCG constants), one character per byte 0..255.
function randomBytes(seed: number, length: number): string {
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out += String.fromCharCode((state >>> 16) & 0xff);
  }
  return out;
}

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

describe('App with a raw paste, no bracketed paste markers', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(resetMocks);

  afterEach(() => {
    cleanup();
  });

  it('treats 150 raw lines in one read as a paste capped at 200 characters, no Enter fired', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame, resize } = await mounted;
    await resize(WIDE_COLUMNS, TALL_ROWS);

    await write(pastedText);

    await waitForFrame((f) => f.includes('> def function_1(arg): return arg * 1 # some comment'));
    // Four flattened lines are 203 characters: the cap ends inside line four.
    expect(frame()).toContain('function_4(arg)');
    expect(frame()).not.toContain('function_5');
    expectNothingActed(vault);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('treats a raw paste of coloured text, whose first line arrives alone, as text', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write(COLOURED_PASTE);

    await waitForFrame((f) => f.includes('> demo x b c'));
    expect(frame()).toContain('> demo x b c');
    expectNothingActed(vault);
    expect(exitMock).not.toHaveBeenCalled();
  });

  for (const { name, raw, shown } of UNRESOLVED_SEQUENCE_PASTES) {
    it(`drops the escape sequences of a raw paste whole (${name}), tails never typed`, async () => {
      const { vault, mounted } = mountThree();
      const { frame, write, waitForFrame } = await mounted;

      await write(raw);

      await waitForFrame((f) => f.includes(`> ${shown}`));
      expect(queryShown(frame())).toBe(shown);
      expectNothingActed(vault);
      expect(exitMock).not.toHaveBeenCalled();
    });
  }

  // One short coloured line is keys, not a paste; the colour codes are still no text.
  it('drops an escape sequence that arrives among keys instead of typing its tail', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write('\x1b[1mBold\x1b[0m');

    await waitForFrame((f) => f.includes('> Bold'));
    expect(queryShown(frame())).toBe('Bold');
    expectNothingActed(vault);
  });

  // A focus report is a CSI sequence Ink does not know; before, its tail "[I" was typed.
  it('ignores a key sequence Ink does not know instead of typing its tail', async () => {
    const { mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write('a');
    await write('\x1b[I');
    await write('b');

    await waitForFrame((f) => f.includes('> ab'));
    expect(queryShown(frame())).toBe('ab');
  });

  // Ink hands an OSC lead or a string terminator over as "]" or "\": typed, they are text.
  it('still types a bracket and a backslash pressed as keys', async () => {
    const { mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write(']');
    await write('\\');

    await waitForFrame((f) => f.includes('> ]\\'));
    expect(queryShown(frame())).toBe(']\\');
  });

  // Ink cuts the read at the colour codes: no single event has two line breaks, the read does.
  it('judges a raw read on all its events together, not one event at a time', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write('demo\n\x1b[33mx\x1b[0m\nb');

    await waitForFrame((f) => f.includes('> demo x b'));
    expect(queryShown(frame())).toBe('demo x b');
    expectNothingActed(vault);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('drops a literal end marker inside a raw paste instead of taking its tail as keys', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write(`demo\n${PASTE_END}xyz\n`);

    await waitForFrame((f) => f.includes('> demo xyz'));
    await settle();
    expect(queryShown(frame())).toBe('demo xyz');
    expectNothingActed(vault);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('treats two line breaks in one short read as a paste, not two Enters', async () => {
    const { vault, mounted } = mountThree();
    const { frame, write, waitForFrame } = await mounted;

    await write('a\rb\r');

    await waitForFrame((f) => f.includes('> a b'));
    expect(frame()).toContain('> a b');
    expectNothingActed(vault);
  });

  it('keeps a single typed line with its Enter as text plus one Enter', async () => {
    const { vault, mounted } = mountThree();
    const { write, waitForFrame } = await mounted;

    await write(`al${KEYS.enter}`);

    await waitForFrame((f) => f.includes('> al'));
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(vault.recordUsage).toHaveBeenCalledTimes(1);
  });

  for (const seed of RANDOM_SEEDS) {
    it(`survives 4096 random bytes in one read (seed ${seed}) with at most one action`, async () => {
      const { vault, mounted } = mountThree();
      const { frame, write } = await mounted;

      await expect(write(randomBytes(seed, RANDOM_BYTES))).resolves.toBeUndefined();
      await settle();

      const actions =
        vi.mocked(vault.toggleFavorite).mock.calls.length +
        openInEditorMock.mock.calls.length +
        clipboardWrite.mock.calls.length;
      expect(actions, `actions after seed ${seed}`).toBeLessThanOrEqual(1);
      expect(frame()).not.toContain('TypeError');
    });
  }

  it('dispatches only the first entry action of a read: three Ctrl+F toggle once', async () => {
    const { vault, mounted } = mountThree();
    const { write } = await mounted;

    await write(`${KEYS.ctrlF}${KEYS.ctrlF}${KEYS.ctrlF}`);

    await vi.waitFor(() => expect(vault.toggleFavorite).toHaveBeenCalledTimes(1));
    await settle();
    expect(vault.toggleFavorite).toHaveBeenCalledTimes(1);
  });

  it('still applies text and arrows that follow a dropped action in the same read', async () => {
    const { vault, mounted } = mountThree();
    const { write, waitForFrame } = await mounted;

    await write(`${KEYS.ctrlF}${KEYS.ctrlF}ab${KEYS.down}`);

    await waitForFrame((f) => f.includes('> ab'));
    expect(vault.toggleFavorite).toHaveBeenCalledTimes(1);
  });

  it('quits on Ctrl+C in its own read right after a paste', async () => {
    const { mounted } = mountThree();
    const { write, waitForFrame } = await mounted;
    await write('a\rb\r');
    await waitForFrame((f) => f.includes('> a b'));

    await write(KEYS.ctrlC);

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1));
  });
});

// The window that joins the pieces of one raw paste is wall-clock time. A frozen Date keeps every
// write inside it and one explicit jump ends it, whatever the load on the machine running this.
describe('App with a raw paste delivered in pieces', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_CLOCK_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  async function mountWide() {
    const { vault, mounted } = mountThree();
    const app = await mounted;
    await app.resize(WIDE_COLUMNS, TALL_ROWS);
    return { vault, ...app };
  }

  it('keeps the space where a piece boundary falls on it', async () => {
    const { vault, frame, write, waitForFrame } = await mountWide();

    await write(`${LONG_PIECE} `);
    await write(SHORT_PIECE);

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE} ${SHORT_PIECE}`));
    expect(frame()).not.toContain(`${LONG_PIECE}${SHORT_PIECE}`);
    expectNothingActed(vault);
  });

  it('keeps one separator where a piece boundary falls on a line break', async () => {
    const { vault, write, waitForFrame } = await mountWide();

    await write(`${LONG_PIECE}\n`);
    await write(`${SHORT_PIECE}\n`);

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE} ${SHORT_PIECE}`));
    expectNothingActed(vault);
  });

  it('keeps the space a piece starts with', async () => {
    const { vault, write, waitForFrame } = await mountWide();

    await write(LONG_PIECE);
    await write(` ${SHORT_PIECE}`);

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE} ${SHORT_PIECE}`));
    expectNothingActed(vault);
  });

  it('turns a piece that is only whitespace into the separator', async () => {
    const { vault, write, waitForFrame } = await mountWide();

    await write(LONG_PIECE);
    await write(' ');
    await write(SHORT_PIECE);

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE} ${SHORT_PIECE}`));
    expectNothingActed(vault);
  });

  // macOS hands a pty write to node in pieces of about 1 KiB; a CR-ended paste one byte over a
  // piece boundary ends in a piece that is exactly "\r", which as a key would act on an entry.
  it('takes a lone Enter inside the window as the line break of the paste, not as a key', async () => {
    const { vault, frame, write, waitForFrame } = await mountWide();
    await write(`${LONG_PIECE}\rbeta\rgamma`);
    await waitForFrame((f) => f.includes('beta gamma'));

    await write(KEYS.enter);
    await write('delta');

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE} beta gamma delta`));
    await settle();
    expectNothingActed(vault);

    // waitForFrame moves the fake clock a little per poll, so the jump is from the clock as it is.
    vi.setSystemTime(Date.now() + PASTE_BURST_MS + 1);
    await write(KEYS.enter);

    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(frame()).toContain(`> ${LONG_PIECE} beta gamma delta`);
  });

  it('takes an unresolved read inside the window as paste and one after it as keys', async () => {
    const { vault, frame, write, waitForFrame } = await mountWide();
    await write(LONG_PIECE);

    await write(`x${KEYS.enter}`);

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE}x`));
    await settle();
    expectNothingActed(vault);

    vi.setSystemTime(FROZEN_CLOCK_MS + PASTE_BURST_MS + 1);
    await write(`y${KEYS.enter}`);

    await waitForFrame((f) => f.includes(`> ${LONG_PIECE}xy`));
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(frame()).toContain(`> ${LONG_PIECE}xy`);
  });
});
