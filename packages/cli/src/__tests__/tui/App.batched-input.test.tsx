import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import {
  KEYS,
  TEST_TIMEOUT_MS,
  makeEntry,
  makeVault,
  mountApp,
  type MountedApp,
} from './harness.js';

const { exitMock, openInEditorMock } = vi.hoisted(() => ({
  exitMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

// Quit is asserted through the exit callback so the app stays mounted and the
// rest of a chunk can still prove it was not typed into the box.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

// A real editor must never start from a unit test.
vi.mock('../../tui/openInEditor.js', () => ({ openInEditor: openInEditorMock }));

const clipboardWrite = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('clipboardy', () => ({ default: { write: clipboardWrite } }));

const WIDE_COLUMNS = 100;
const PREVIEW_LINES = 80;
// 19 rows leave a 14-row body: 12 preview rows inside the border, 7 result rows.
const SHORT_TERMINAL_ROWS = 19;
// More PgDn presses than the 28-line excerpt has pages, so the last ones hit the bottom.
const PAGES_PAST_THE_END = 6;
const PREVIEW_TEXT_ROWS = 12;
const EXCERPT_LAST_ROW = 28;

const previewContent = Array.from(
  { length: PREVIEW_LINES },
  (_, i) => `row-${String(i + 1).padStart(2, '0')}`,
).join('\n');

// Line numbers of the `row-NN` preview lines a frame shows.
const shownRows = (frame: string): number[] =>
  [...frame.matchAll(/row-(\d{2})/g)].map((match) => Number(match[1]));

const names = (count: number) =>
  Array.from({ length: count }, (_, i) => `item-${String(i + 1).padStart(2, '0')}`);

async function mountThree(): Promise<MountedApp> {
  const entries = ['alpha', 'beta', 'gamma'].map((name) => makeEntry(name));
  return mountApp(makeVault(entries));
}

describe('App with several keys in one stdin chunk', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
    openInEditorMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('inserts a pasted run of printable text into the box as one query', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write('abc');

    await waitForFrame((f) => f.includes('> abc'));
    expect(frame()).toContain('> abc');
  });

  it('quits on Ctrl+C typed in the same chunk as text and never types the byte', async () => {
    const { frame, write } = await mountThree();

    await write(`ab${KEYS.ctrlC}`);

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1));
    expect(frame()).not.toContain('\x03');
  });

  it('quits on a double Ctrl+C instead of typing it into the box', async () => {
    const { frame, write } = await mountThree();

    await write(`${KEYS.ctrlC}${KEYS.ctrlC}`);

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());
    expect(frame()).not.toContain('\x03');
  });

  it('runs no action key that follows Ctrl+C in the same chunk', async () => {
    const vault = makeVault([makeEntry('alpha')]);
    const { write } = await mountApp(vault);

    await write(`${KEYS.ctrlC}${KEYS.ctrlF}${KEYS.ctrlO}${KEYS.enter}`);

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1));
    expect(vault.toggleFavorite).not.toHaveBeenCalled();
    expect(openInEditorMock).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('keeps every character around a page key inside the same chunk', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write(`a${KEYS.pageDown}b`);

    await waitForFrame((f) => f.includes('> ab'));
    expect(frame()).toContain('> ab');
  });

  it('applies an arrow key before the Ctrl+F that follows it in the chunk', async () => {
    const vault = makeVault(['alpha', 'beta', 'gamma'].map((name) => makeEntry(name)));
    const { write } = await mountApp(vault);

    await write(`${KEYS.down}${KEYS.ctrlF}`);

    await vi.waitFor(() => expect(vault.toggleFavorite).toHaveBeenCalledTimes(1));
    expect(vault.toggleFavorite).toHaveBeenCalledWith('beta');
  });

  it('keeps the arrow selection when text is typed earlier in the same chunk', async () => {
    const { write, waitForFrame } = await mountThree();

    await write(`a${KEYS.down}`);

    await waitForFrame((f) => f.includes('> a') && f.includes('▶ beta'));
    // Let the debounced search land: the selection must survive the new results.
    await new Promise((done) => setTimeout(done, 200));
    await waitForFrame((f) => f.includes('▶ beta'));
  });

  it('returns the selection to the first result when the query changes', async () => {
    const { write, waitForFrame } = await mountThree();
    await write(`${KEYS.down}${KEYS.down}`);
    await waitForFrame((f) => f.includes('▶ gamma'));

    await write('a');

    await waitForFrame((f) => f.includes('> a') && f.includes('▶ alpha'));
  });

  it('clears text typed in the same read when the chunk ends with Esc', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write(`xy${KEYS.escape}`);

    await waitForFrame((f) => f.includes('Search commands'));
    expect(frame()).not.toContain('xy');
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('quits on Ctrl+C that directly follows an Esc in the same chunk', async () => {
    const { write } = await mountThree();

    await write(`${KEYS.escape}${KEYS.ctrlC}`);

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());
  });

  // A terminal sends Alt+z as ESC then "z", the same bytes as Esc and z in one
  // read, and Ink reports both as one Alt+z event. Alt chords are ignored by the
  // box, so an Esc only counts as Esc when it ends the read (or doubles).
  it('treats ESC plus a printable byte in one read as an ignored Alt chord', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write(`xy${KEYS.escape}z`);

    await waitForFrame((f) => f.includes('> xy'));
    expect(frame()).not.toContain('z');
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('applies cursor moves in order between typed characters', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write(`ac${KEYS.left}b`);

    await waitForFrame((f) => f.includes('> abc'));
    expect(frame()).toContain('> abc');
  });

  it('deletes with repeated backspaces delivered in one chunk', async () => {
    const { write, waitForFrame } = await mountThree();

    await write(`abcd${KEYS.backspace}${KEYS.backspace}`);

    await waitForFrame((f) => f.includes('> ab') && !f.includes('abc'));
  });

  it('opens the editor on Ctrl+O typed after text without typing an o', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write(`ab${KEYS.ctrlO}`);

    await vi.waitFor(() => expect(openInEditorMock).toHaveBeenCalledTimes(1));
    expect(openInEditorMock).toHaveBeenCalledWith('/fake/alpha.md');
    await waitForFrame((f) => f.includes('> ab'));
    expect(frame()).not.toContain('abo');
  });

  it('drops control bytes that mean nothing instead of typing them', async () => {
    const { frame, write, waitForFrame } = await mountThree();

    await write('a\x1cb\x00c');

    await waitForFrame((f) => f.includes('> abc'));
    expect(frame()).not.toContain('\x1c');
    expect(frame()).not.toContain('\x00');
  });
});

// A vault whose search really filters, so a stale list is distinguishable from a fresh one.
const NAMES = ['alpha', 'beta', 'gamma'];
const filteringVault = () => {
  const entries = NAMES.map((name) => makeEntry(name));
  return makeVault(entries, ({ query }) => entries.filter((e) => e.name.includes(query)));
};

describe('App with an entry action typed right after text', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
    openInEditorMock.mockReset();
    clipboardWrite.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('favorites the entry the typed query finds, not the row the old list had selected', async () => {
    const vault = filteringVault();
    const { write } = await mountApp(vault);
    await write(`${KEYS.down}${KEYS.down}`);

    await write(`gam${KEYS.ctrlF}`);

    await vi.waitFor(() => expect(vault.toggleFavorite).toHaveBeenCalledTimes(1));
    expect(vault.toggleFavorite).toHaveBeenCalledWith('gamma');
  });

  it('opens the editor on the entry the typed query finds', async () => {
    const { write } = await mountApp(filteringVault());

    await write(`bet${KEYS.ctrlO}`);

    await vi.waitFor(() => expect(openInEditorMock).toHaveBeenCalledTimes(1));
    expect(openInEditorMock).toHaveBeenCalledWith('/fake/beta.md');
  });

  it('copies the slash command of the entry the typed query finds on Enter', async () => {
    const vault = filteringVault();
    const { write } = await mountApp(vault);

    await write(`gam${KEYS.enter}`);

    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(clipboardWrite).toHaveBeenCalledWith('/gamma');
    expect(vault.recordUsage).toHaveBeenCalledWith('gamma');
  });

  it('does nothing when the typed query finds no entry', async () => {
    const vault = filteringVault();
    const { write } = await mountApp(vault);

    await write(`zzz${KEYS.ctrlF}`);
    await new Promise((done) => setTimeout(done, 150));

    expect(vault.toggleFavorite).not.toHaveBeenCalled();
  });
});

describe('App with Esc in a stdin chunk', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('quits on a double Esc in one chunk instead of dropping the second one', async () => {
    const { write } = await mountThree();

    await write(`${KEYS.escape}${KEYS.escape}`);

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());
  });

  it('moves the selection back to the first result when Esc clears the query', async () => {
    const { write, waitForFrame } = await mountThree();
    await write('a');
    await waitForFrame((f) => f.includes('> a'));
    await write(`${KEYS.down}${KEYS.down}`);
    await waitForFrame((f) => f.includes('▶ gamma'));

    await write(KEYS.escape);

    await waitForFrame((f) => f.includes('Search commands') && f.includes('▶ alpha'));
  });
});

describe('App paging', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('PgDn and PgUp move the preview by one page of visible rows', async () => {
    const vault = makeVault([makeEntry('alpha', { content: previewContent })]);
    const { write, waitForFrame, resize } = await mountApp(vault);
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);
    // The 12 rows inside the border show the start of the content.
    await waitForFrame((f) => shownRows(f).length > 0 && Math.max(...shownRows(f)) <= 14);

    await write(KEYS.pageDown);
    // One page down: the pane now starts where the first page ended.
    await waitForFrame((f) => shownRows(f).length > 0 && Math.min(...shownRows(f)) >= 13);

    await write(KEYS.pageUp);
    await waitForFrame((f) => shownRows(f).length > 0 && Math.max(...shownRows(f)) <= 14);
  });

  it('draws every line of a page, without dropping any from the middle', async () => {
    const vault = makeVault([makeEntry('alpha', { content: previewContent })]);
    const { write, waitForFrame, resize } = await mountApp(vault);
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);
    const firstPage = Array.from({ length: PREVIEW_TEXT_ROWS }, (_, i) => i + 1);
    const secondPage = firstPage.map((row) => row + PREVIEW_TEXT_ROWS);

    await waitForFrame((f) => shownRows(f).join() === firstPage.join());

    await write(KEYS.pageDown);
    await waitForFrame((f) => shownRows(f).join() === secondPage.join());
  });

  it('PgUp moves the preview right after PgDn hit the bottom of a long entry', async () => {
    const vault = makeVault([makeEntry('alpha', { content: previewContent })]);
    const { write, waitForFrame, resize } = await mountApp(vault);
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);

    // The pane holds an excerpt of 2 x 14 lines; the bottom page ends on its last line.
    for (let press = 0; press < PAGES_PAST_THE_END; press += 1) await write(KEYS.pageDown);
    await waitForFrame((f) => shownRows(f).includes(EXCERPT_LAST_ROW));

    await write(KEYS.pageUp);
    await waitForFrame((f) => shownRows(f).length > 0 && Math.max(...shownRows(f)) < 17);
  });

  it('pages inside the excerpt around the match when a query is active', async () => {
    const lines = previewContent.split('\n');
    lines[59] = 'row-60 needle';
    const vault = makeVault([makeEntry('alpha', { content: lines.join('\n') })]);
    const { write, waitForFrame, resize } = await mountApp(vault);
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);
    await write('needle');
    // The excerpt is rows 46-73; its first page starts at row 46.
    await waitForFrame((f) => Math.min(...shownRows(f)) === 46);

    for (let press = 0; press < PAGES_PAST_THE_END; press += 1) await write(KEYS.pageDown);
    await waitForFrame((f) => shownRows(f).includes(73));

    await write(KEYS.pageUp);
    await waitForFrame((f) => shownRows(f).length > 0 && Math.max(...shownRows(f)) < 62);
  });

  it('starts an entry from its first line again after the selection left it and came back', async () => {
    const entries = [makeEntry('alpha', { content: previewContent }), makeEntry('beta')];
    const { write, waitForFrame, resize } = await mountApp(makeVault(entries));
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);
    await write(KEYS.pageDown);
    await waitForFrame((f) => shownRows(f).length > 0 && Math.min(...shownRows(f)) >= 13);

    await write(`${KEYS.down}${KEYS.up}`);

    await waitForFrame((f) => shownRows(f).length > 0 && Math.max(...shownRows(f)) <= 14);
  });

  it('keeps the preview where it is when an arrow key cannot move the selection', async () => {
    const vault = makeVault([makeEntry('alpha', { content: previewContent })]);
    const { write, waitForFrame, resize } = await mountApp(vault);
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);
    await write(KEYS.pageDown);
    await waitForFrame((f) => shownRows(f).length > 0 && Math.min(...shownRows(f)) >= 13);

    await write(`${KEYS.down}${KEYS.up}${KEYS.up}`);
    await new Promise((done) => setTimeout(done, 50));

    await waitForFrame((f) => shownRows(f).length > 0 && Math.min(...shownRows(f)) >= 13);
  });

  it('restarts the preview at the top when a new query selects another entry', async () => {
    const entries = [
      makeEntry('alpha', { content: previewContent }),
      makeEntry('beta', { content: previewContent.replaceAll('row-', 'line-') }),
    ];
    const vault = makeVault(entries, ({ query }) => (query === 'b' ? [entries[1]!] : entries));
    const { write, waitForFrame, resize } = await mountApp(vault);
    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);
    await write(KEYS.pageDown);
    await waitForFrame((f) => shownRows(f).length > 0 && Math.min(...shownRows(f)) >= 13);

    await write('b');

    await waitForFrame((f) => f.includes('line-05') && !f.includes('line-22'));
  });

  it('keeps a selected row on screen when a query shrinks the list under the selection', async () => {
    const entries = names(12).map((name) => makeEntry(name));
    const vault = makeVault(entries, ({ query }) =>
      query === 'zz' ? entries.slice(0, 3) : entries,
    );
    const { write, waitForFrame, frame } = await mountApp(vault);

    // The arrows land inside the search debounce window, on the old long list.
    await write(`zz${KEYS.down.repeat(7)}`);

    await waitForFrame((f) => !f.includes('item-12'));
    expect(frame()).toContain('▶ item-03');
  });

  it('keeps the selected row on screen when the terminal shrinks under it', async () => {
    const entries = names(12).map((name) => makeEntry(name));
    const { write, waitForFrame, resize, frame } = await mountApp(makeVault(entries));
    await write(KEYS.down.repeat(11));
    await waitForFrame((f) => f.includes('▶ item-12'));

    await resize(WIDE_COLUMNS, SHORT_TERMINAL_ROWS);

    await waitForFrame((f) => f.includes('▶ item-12') && !f.includes('item-01'));
    expect(frame()).toContain('▶ item-12');
  });
});
