import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { CommandError } from '../../errors.js';
import { CLEAR_SCREEN } from '../../tui/terminal.js';
import { KEYS, TEST_TIMEOUT_MS, makeEntry, makeVault, mountApp } from './harness.js';

const { exitMock, openInEditorMock } = vi.hoisted(() => ({
  exitMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

// A real editor must never start from a unit test.
vi.mock('../../tui/openInEditor.js', () => ({ openInEditor: openInEditorMock }));

vi.mock('clipboardy', () => ({ default: { write: vi.fn().mockResolvedValue(undefined) } }));

const mountOne = () => mountApp(makeVault([makeEntry('alpha')]));

describe('App: opening the selected entry in an editor', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    exitMock.mockReset();
    openInEditorMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('redraws the whole screen after the editor closes', async () => {
    const { write, writes } = await mountOne();
    expect(writes().some((text) => text.includes(CLEAR_SCREEN))).toBe(false);

    await write(KEYS.ctrlO);

    await vi.waitFor(() => expect(openInEditorMock).toHaveBeenCalledWith('/fake/alpha.md'));
    await vi.waitFor(() =>
      expect(writes().some((text) => text.startsWith(CLEAR_SCREEN))).toBe(true),
    );
    // Clearing the scrollback would delete the shell history above the TUI.
    expect(writes().join('')).not.toContain('[3J');
  });

  it('redraws after a failed launch as well, and says what went wrong in the hint bar', async () => {
    openInEditorMock.mockImplementation(() => {
      throw new CommandError('failed to open editor (nope): command not found');
    });
    const { write, writes, waitForFrame, frame } = await mountOne();

    await write(KEYS.ctrlO);

    await waitForFrame((f) => f.includes('failed to open editor (nope)'));
    expect(writes().some((text) => text.startsWith(CLEAR_SCREEN))).toBe(true);
    expect(frame()).toContain('alpha');
    expect(exitMock).not.toHaveBeenCalled();
  });
});
