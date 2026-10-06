import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultEntry } from '@commandvault/core';
import { commands, window } from 'vscode';
import { registerCommands } from '../commands/index';
import { MOCK_ENTRIES } from './fixtures/mock-entries';
import { expectShownNotificationsInert, shownNotifications } from './helpers/notification-links';

/**
 * "Insert to terminal" writes an entry's slash command to the shell's input. A terminal reads a
 * newline as Enter, so an entry named `x\nrm -rf ~` ran `x` and left the rest to run: an entry name
 * is text a plugin or a cloned repository chose, and may hold a newline. An escape sequence is as
 * bad (a line editor reads it as keystrokes, and `ESC [ 201 ~` ends a bracketed paste early), and
 * so is any other control character (Ctrl-C, Ctrl-U, backspace, NUL). The command must refuse
 * text with one and send nothing, and it must never add a newline of its own.
 */

const REFUSED = 'CommandVault: Not inserted into the terminal - the text has a control character';
const COUNT_OF_CONTROL_CHARACTERS = 0x20 + 0x21;

type Handler = (argument?: unknown) => unknown;

interface FakeTerminal {
  readonly show: ReturnType<typeof vi.fn>;
  readonly sendText: ReturnType<typeof vi.fn>;
}

function fakeTerminal(): FakeTerminal {
  return { show: vi.fn(), sendText: vi.fn() };
}

function setActiveTerminal(terminal: FakeTerminal | undefined): void {
  Object.assign(window, { activeTerminal: terminal });
}

/** The insert command, for a vault whose slash command for every entry is `slashCommand`. */
function insertHandler(slashCommand: string): Handler {
  (commands.registerCommand as ReturnType<typeof vi.fn>).mockClear();
  const vault = { getSlashCommand: vi.fn(() => slashCommand), recordUsage: vi.fn() };
  const provider = { refresh: vi.fn() } as never;
  registerCommands({ subscriptions: [] } as never, vault as never, provider, provider, provider);
  const calls = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls;
  const registered = calls.find(([id]) => id === 'commandvault.insertToTerminal');
  if (registered === undefined) throw new Error('commandvault.insertToTerminal not registered');
  return registered[1] as Handler;
}

const ENTRY: VaultEntry = MOCK_ENTRIES[0];

const HOSTILE_COMMANDS: readonly (readonly [string, string])[] = [
  ['a newline that starts a second command', '/x\nrm -rf ~'],
  ['a newline at the end', '/x\n'],
  ['only a newline', '\n'],
  ['a carriage return', '/x\rrm -rf ~'],
  ['a carriage return and a newline', '/x\r\nrm -rf ~\r\n'],
  ['a vertical tab', '/x\u000brm -rf ~'],
  ['a form feed', '/x\u000crm -rf ~'],
  ['an escape sequence', '/x\u001b[2Jrm -rf ~'],
  ['the end of a bracketed paste', '/x\u001b[201~rm -rf ~\n'],
  ['the start of a bracketed paste', '\u001b[200~/x'],
  ['an escape that ends the text', '/x\u001b'],
  ['a NUL', '/x\u0000rm -rf ~'],
  ['Ctrl-C', '/x\u0003'],
  ['Ctrl-D', '/x\u0004'],
  ['Ctrl-U, which kills the line', 'rm -rf ~\u0015/x'],
  ['a backspace', '/x\u0008\u0008\u0008rm -rf ~'],
  ['a tab, which completes', '/x\t'],
  ['a delete character', '/x\u007f'],
  ['the C1 next-line character', '/x\u0085rm -rf ~'],
  ['the C1 single-byte control sequence introducer', '/x\u009b2J'],
  ['the C1 operating system command', '/x\u009d0;title'],
  ['the last C1 control character', '/x\u009f'],
  ['a line separator', '/x\u2028rm -rf ~'],
  ['a paragraph separator', '/x\u2029rm -rf ~'],
];

describe('insert to terminal: text with a control character is refused', () => {
  let active: FakeTerminal;

  beforeEach(() => {
    vi.clearAllMocks();
    active = fakeTerminal();
    setActiveTerminal(active);
  });

  afterEach(() => {
    setActiveTerminal(undefined);
  });

  it.each(HOSTILE_COMMANDS)('sends nothing for %s', (_name, text) => {
    insertHandler(text)(ENTRY);

    expect(active.sendText).not.toHaveBeenCalled();
    expect(shownNotifications()).toEqual([REFUSED]);
    expectShownNotificationsInert();
  });

  it.each(HOSTILE_COMMANDS)('does not even show the terminal for %s', (_name, text) => {
    insertHandler(text)({ entry: ENTRY });

    expect(active.show).not.toHaveBeenCalled();
  });

  it.each(HOSTILE_COMMANDS)('does not open a terminal of its own for %s', (_name, text) => {
    setActiveTerminal(undefined);

    insertHandler(text)(ENTRY);

    expect(window.createTerminal).not.toHaveBeenCalled();
  });

  it('refuses every control character in the text, wherever it stands in it', () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ];
    expect(controls).toHaveLength(COUNT_OF_CONTROL_CHARACTERS);

    for (const code of controls) {
      const control = String.fromCharCode(code);
      for (const text of [`${control}review`, `re${control}view`, `review${control}`]) {
        insertHandler(text)(ENTRY);
      }
    }

    expect(active.sendText).not.toHaveBeenCalled();
    expect(shownNotifications()).toHaveLength(COUNT_OF_CONTROL_CHARACTERS * 3);
    expect(new Set(shownNotifications())).toEqual(new Set([REFUSED]));
  });

  it('does not put the hostile text in the toast either', () => {
    insertHandler('/x\nrm -rf ~')(ENTRY);

    expect(shownNotifications().join('')).not.toContain('rm -rf');
  });
});

describe('insert to terminal: text without a control character is still inserted, unexecuted', () => {
  let active: FakeTerminal;

  beforeEach(() => {
    vi.clearAllMocks();
    active = fakeTerminal();
    setActiveTerminal(active);
  });

  afterEach(() => {
    setActiveTerminal(undefined);
  });

  it('sends the slash command to the active terminal and asks for no newline', () => {
    insertHandler('/review')(ENTRY);

    expect(active.show).toHaveBeenCalledTimes(1);
    expect(active.sendText).toHaveBeenCalledTimes(1);
    expect(active.sendText).toHaveBeenCalledWith('/review', false);
    expect(shownNotifications()).toEqual(['CommandVault: Inserted "/review" into terminal']);
  });

  it('opens a terminal when none is active', () => {
    setActiveTerminal(undefined);
    const created = fakeTerminal();
    (window.createTerminal as ReturnType<typeof vi.fn>).mockReturnValueOnce(created);

    insertHandler('/review')({ entry: ENTRY });

    expect(window.createTerminal).toHaveBeenCalledWith('CommandVault');
    expect(created.sendText).toHaveBeenCalledWith('/review', false);
  });

  it.each([
    ['spaces and quotes', '/plugin:my tool "quoted"'],
    ['shell punctuation, which is only text until the user presses Enter', '/a;b && c | d $(e)'],
    ['non-ASCII letters', '/déploie-日本語'],
    ['the no-break space, the first character after the C1 controls', '/a\u00a0b'],
    ['a backslash and a tilde', '/C:\\Users\\me ~'],
  ])('inserts %s as it is', (_name, text) => {
    insertHandler(text)(ENTRY);

    expect(active.sendText).toHaveBeenCalledWith(text, false);
  });

  it('inserts every printable ASCII character, the space to the tilde', () => {
    for (let code = 0x20; code <= 0x7e; code += 1) {
      insertHandler(`/a${String.fromCharCode(code)}b`)(ENTRY);
    }

    expect(active.sendText).toHaveBeenCalledTimes(0x7e - 0x20 + 1);
    for (const [, shouldExecute] of active.sendText.mock.calls) {
      expect(shouldExecute).toBe(false);
    }
  });

  it('never asks the terminal to run what it sent', () => {
    insertHandler('/review')(ENTRY);
    insertHandler('/other')({ entry: ENTRY });

    for (const call of active.sendText.mock.calls) {
      expect(call).toHaveLength(2);
      expect(call[1]).toBe(false);
      expect(String(call[0])).not.toMatch(/[\r\n]$/);
    }
  });
});
