import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandError } from '../../errors.js';

const { runEditor } = vi.hoisted(() => ({ runEditor: vi.fn() }));
vi.mock('../../editor.js', () => ({ openInEditor: runEditor }));

import { openInEditor, type EditorTerminal } from '../../tui/openInEditor.js';
import { CLEAR_SCREEN, HIDE_CURSOR, SHOW_CURSOR } from '../../tui/terminal.js';

/** A terminal that records what the hand-off does to it, in order. */
function fakeTerminal(options: { isTTY: boolean; isRaw: boolean }): {
  readonly terminal: EditorTerminal;
  readonly log: string[];
} {
  const log: string[] = [];
  const terminal: EditorTerminal = {
    stdin: {
      isTTY: options.isTTY,
      isRaw: options.isRaw,
      setRawMode: (mode: boolean) => log.push(`raw:${String(mode)}`),
    },
    stdout: { write: (text: string) => log.push(`write:${JSON.stringify(text)}`) },
  };
  return { terminal, log };
}

describe('openInEditor (TUI hand-off)', () => {
  beforeEach(() => {
    runEditor.mockReset();
  });

  it('frees the keyboard and screen for the editor, then takes them back', () => {
    const { terminal, log } = fakeTerminal({ isTTY: true, isRaw: true });
    runEditor.mockImplementation(() => log.push('editor'));

    openInEditor('/fake/a.md', terminal);

    expect(log).toEqual([
      'raw:false',
      `write:${JSON.stringify(SHOW_CURSOR + CLEAR_SCREEN)}`,
      'editor',
      'raw:true',
      `write:${JSON.stringify(HIDE_CURSOR)}`,
    ]);
    expect(runEditor).toHaveBeenCalledWith('/fake/a.md');
  });

  it('never erases the scrollback, which holds the shell history above the TUI', () => {
    const { terminal, log } = fakeTerminal({ isTTY: true, isRaw: true });

    openInEditor('/fake/a.md', terminal);

    expect(log.join('')).not.toContain('[3J');
    expect(CLEAR_SCREEN).not.toContain('[3J');
  });

  it('takes the terminal back even when the editor fails, and lets the error through', () => {
    const { terminal, log } = fakeTerminal({ isTTY: true, isRaw: true });
    runEditor.mockImplementation(() => {
      throw new CommandError('failed to open editor (nope): command not found');
    });

    expect(() => openInEditor('/fake/a.md', terminal)).toThrow(CommandError);

    expect(log.slice(-2)).toEqual(['raw:true', `write:${JSON.stringify(HIDE_CURSOR)}`]);
  });

  it('leaves raw mode off afterwards when it was off before', () => {
    const { terminal, log } = fakeTerminal({ isTTY: true, isRaw: false });

    openInEditor('/fake/a.md', terminal);

    expect(log.filter((entry) => entry.startsWith('raw:'))).toEqual(['raw:false', 'raw:false']);
  });

  it('does not touch raw mode when stdin is not a terminal', () => {
    const { terminal, log } = fakeTerminal({ isTTY: false, isRaw: false });

    openInEditor('/fake/a.md', terminal);

    expect(log.filter((entry) => entry.startsWith('raw:'))).toEqual([]);
    expect(runEditor).toHaveBeenCalledOnce();
  });
});
