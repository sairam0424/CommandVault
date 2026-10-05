import { openInEditor as runEditor } from '../editor.js';
import { CLEAR_SCREEN, HIDE_CURSOR, SHOW_CURSOR } from './terminal.js';

/** The slice of the terminal the editor hand-off touches; tests supply a fake. */
export interface EditorTerminal {
  readonly stdin: {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  readonly stdout: { write: (text: string) => unknown };
}

const PROCESS_TERMINAL: EditorTerminal = { stdin: process.stdin, stdout: process.stdout };

/**
 * Hands the terminal to the user's editor and takes it back when the editor closes. Raw mode is
 * released and the cursor shown while the editor runs, because the editor sets up its own modes.
 * The editor is run with a blocking spawn on purpose: while it runs this process reads nothing,
 * so no key meant for the editor is swallowed by the TUI's own stdin reader.
 *
 * The caller redraws the TUI afterwards; the editor may have left anything on the screen.
 * Throws a CommandError when the editor cannot start or fails.
 */
export function openInEditor(filePath: string, terminal: EditorTerminal = PROCESS_TERMINAL): void {
  const { stdin, stdout } = terminal;
  const wasRaw = Boolean(stdin.isTTY && stdin.isRaw);
  if (stdin.isTTY) stdin.setRawMode?.(false);
  stdout.write(SHOW_CURSOR + CLEAR_SCREEN);
  try {
    runEditor(filePath);
  } finally {
    if (stdin.isTTY) stdin.setRawMode?.(wasRaw);
    stdout.write(HIDE_CURSOR);
  }
}
