import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import type { VaultEntry, Vault } from '@commandvault/core';

const { exitMock, openInEditorMock } = vi.hoisted(() => ({
  exitMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

// Quit is asserted through the exit callback so the app stays mounted and
// later keystrokes can still prove nothing else reacted to the earlier ones.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

// A real editor must never start from a unit test.
vi.mock('../../tui/openInEditor.js', () => ({ openInEditor: openInEditorMock }));

vi.mock('clipboardy', () => ({ default: { write: vi.fn().mockResolvedValue(undefined) } }));

// Real control bytes, exactly what a terminal in raw mode delivers.
const CTRL_C = '\x03';
const CTRL_F = '\x06';
const CTRL_O = '\x0f';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const ESC = '\x1b';
const LEFT_ARROW = '\x1b[D';
const BACKSPACE = '\x7f';

const TYPED_QUERY = 'quick fox [qa] of';
const PREVIEW_LINE_COUNT = 80;
const POLL_TIMEOUT_MS = 10_000;
// Each key press is a full Ink render; Windows CI runners are the slow case.
const TEST_TIMEOUT_MS = 30_000;
// The harness terminal has 30 rows, so the preview box is 25 rows tall and
// shows 23 lines inside its border: the last one is row-23 until it scrolls.
const LAST_ROW_BEFORE_SCROLL = 'row-23';
const FIRST_ROW_AFTER_SCROLL = 'row-24';

const longContent = Array.from(
  { length: PREVIEW_LINE_COUNT },
  (_, i) => `row-${String(i + 1).padStart(2, '0')}`,
).join('\n');

function makeEntry(name: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: name,
    name,
    type: 'skill',
    source: 'custom',
    description: `${name} description`,
    filePath: `/fake/${name}.md`,
    tags: [],
    metadata: {},
    content: longContent,
    lastModified: new Date('2026-01-01'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

function makeVault(entries: VaultEntry[]): Vault {
  return {
    search: vi
      .fn()
      .mockReturnValue(entries.map((e) => ({ entry: e, score: 1, matchedFields: [] as string[] }))),
    getAllEntries: vi.fn().mockReturnValue(entries),
    recordUsage: vi.fn(),
    toggleFavorite: vi.fn().mockReturnValue(true),
    getSlashCommand: vi.fn().mockImplementation((e: VaultEntry) => `/${e.name}`),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Vault;
}

// Ink applies a keystroke's state update on React's next scheduler turn, so
// a burst of synchronous writes would all see the same stale value. A real
// terminal delivers each key as its own event; yielding one macrotask after
// each write reproduces that without any wall-clock wait.
const yieldToReact = () => new Promise<void>((done) => setImmediate(done));

// Colour support differs between CI runners; compare on the plain text.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

async function mountApp(vault: Vault) {
  const { App } = await import('../../tui/App.js');
  const app = render(<App vault={vault} />);
  const frame = () => (app.lastFrame() ?? '').replace(ANSI_PATTERN, '');
  const press = async (sequence: string) => {
    app.stdin.write(sequence);
    await yieldToReact();
  };
  const type = async (text: string) => {
    for (const char of text) await press(char);
  };
  const waitForFrame = (predicate: (f: string) => boolean) =>
    vi.waitFor(() => expect(predicate(frame())).toBe(true), {
      timeout: POLL_TIMEOUT_MS,
      interval: 10,
    });
  return { frame, press, type, waitForFrame };
}

describe('App key handling', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
    openInEditorMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  describe('typing in the search box', () => {
    it('puts every character of a query containing q, o, f, [ and ] into the box', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame, type, waitForFrame } = await mountApp(vault);

      await type(TYPED_QUERY);

      await waitForFrame((f) => f.includes(TYPED_QUERY));
      expect(frame()).toContain(TYPED_QUERY);
    });

    it('does not quit, open an editor or toggle a favorite while typing', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { type, waitForFrame } = await mountApp(vault);

      await type(TYPED_QUERY);
      await waitForFrame((f) => f.includes(TYPED_QUERY));

      expect(exitMock).not.toHaveBeenCalled();
      expect(openInEditorMock).not.toHaveBeenCalled();
      expect(vault.toggleFavorite).not.toHaveBeenCalled();
    });

    it('does not scroll the preview when [ and ] are typed', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame, type, waitForFrame } = await mountApp(vault);

      await type(']]]]');
      await waitForFrame((f) => f.includes(']]]]'));

      expect(frame()).toContain(LAST_ROW_BEFORE_SCROLL);
      expect(frame()).not.toContain(FIRST_ROW_AFTER_SCROLL);
    });
  });

  describe('actions on non-printable keys', () => {
    it('Ctrl+F toggles the selected favorite without typing an f', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame, type, press, waitForFrame } = await mountApp(vault);
      await type('xy');
      await waitForFrame((f) => f.includes('xy'));

      await press(CTRL_F);

      await waitForFrame((f) => f.includes('Added to favorites: alpha'));
      expect(vault.toggleFavorite).toHaveBeenCalledTimes(1);
      expect(vault.toggleFavorite).toHaveBeenCalledWith('alpha');
      expect(frame()).not.toContain('xyf');
    });

    it('Ctrl+O asks for the editor on the selected file without typing an o', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame, type, press, waitForFrame } = await mountApp(vault);
      await type('xy');
      await waitForFrame((f) => f.includes('xy'));

      await press(CTRL_O);

      await vi.waitFor(() => expect(openInEditorMock).toHaveBeenCalledTimes(1), {
        timeout: POLL_TIMEOUT_MS,
      });
      expect(openInEditorMock).toHaveBeenCalledWith('/fake/alpha.md');
      expect(frame()).not.toContain('xyo');
    });

    it('PageDown and PageUp scroll the preview', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { press, waitForFrame } = await mountApp(vault);
      await waitForFrame((f) => f.includes(LAST_ROW_BEFORE_SCROLL));

      await press(PAGE_DOWN);
      await waitForFrame((f) => f.includes(FIRST_ROW_AFTER_SCROLL));

      await press(PAGE_UP);
      await waitForFrame((f) => !f.includes(FIRST_ROW_AFTER_SCROLL));
    });

    it('Ctrl+C quits', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { press } = await mountApp(vault);

      await press(CTRL_C);

      await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1), {
        timeout: POLL_TIMEOUT_MS,
      });
    });

    it('Esc clears a non-empty query first and quits only when it is already empty', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame, type, press, waitForFrame } = await mountApp(vault);
      await type('xy');
      await waitForFrame((f) => f.includes('xy'));

      await press(ESC);
      await waitForFrame((f) => !f.includes('xy'));
      expect(exitMock).not.toHaveBeenCalled();
      expect(frame()).toContain('Search commands');

      await press(ESC);
      await vi.waitFor(() => expect(exitMock).toHaveBeenCalledTimes(1), {
        timeout: POLL_TIMEOUT_MS,
      });
    });
  });

  describe('key hints', () => {
    it('advertise the new keys and none of the old printable ones', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame } = await mountApp(vault);

      expect(frame()).toContain('^O Open');
      expect(frame()).toContain('^F');
      expect(frame()).toContain('PgUp/PgDn');
      expect(frame()).toContain('^C Quit');
      expect(frame()).not.toContain('[o Open]');
      expect(frame()).not.toContain('[f ');
      expect(frame()).not.toContain('[q Quit]');
    });

    it('still advertise quit when nothing is selected', async () => {
      const vault = makeVault([]);
      const { frame } = await mountApp(vault);

      expect(frame()).toContain('^C Quit');
      expect(frame()).not.toContain('[q Quit]');
    });
  });

  describe('cursor editing inside the search box', () => {
    it('inserts at the cursor after the left arrow and deletes with backspace', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { frame, type, press, waitForFrame } = await mountApp(vault);
      await type('xz');
      await waitForFrame((f) => f.includes('xz'));

      await press(LEFT_ARROW);
      await type('y');
      await waitForFrame((f) => f.includes('xyz'));

      await press(BACKSPACE);
      await waitForFrame((f) => !f.includes('xyz') && f.includes('xz'));
      expect(frame()).toContain('xz');
    });

    it('keeps the cursor where it was when a Ctrl action key is pressed', async () => {
      const vault = makeVault([makeEntry('alpha')]);
      const { type, press, waitForFrame } = await mountApp(vault);
      await type('xz');
      await waitForFrame((f) => f.includes('xz'));

      await press(LEFT_ARROW);
      await press(CTRL_F);
      await waitForFrame((f) => f.includes('Added to favorites'));
      await type('y');

      await waitForFrame((f) => f.includes('xyz'));
    });
  });
});
