/** Terminal escape sequences the TUI writes itself. */

// Clears the visible screen only. `ESC [ 3 J` would also erase the scrollback, which is the user's
// shell history above the TUI and not ours to delete.
export const CLEAR_SCREEN = '\u001B[2J\u001B[H';
export const SHOW_CURSOR = '\u001B[?25h';
export const HIDE_CURSOR = '\u001B[?25l';
