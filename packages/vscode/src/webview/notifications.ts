import * as vscode from 'vscode';

/**
 * Every toast the extension shows goes through notifyInfo, notifyWarn or notifyError.
 *
 * VS Code 1.138 reads a notification message with parseLinkedText, whose one pattern is
 * `[label](href)` with `href` starting `http://`, `https://`, `command:` or `file:`; a match is
 * drawn as a button that opens `href` with commands allowed, so `[x](command:workbench.action.
 * terminal.sendSequence?...)` in a message runs that command when the user clicks it. Every other
 * part of the message becomes a DOM text node: no emphasis, no HTML, no backslash escapes. Before
 * the pattern is applied the message is only cut at 1,000 characters, its line breaks become
 * spaces and it is trimmed, so a link cannot be drawn without `](`, the two characters back to back.
 *
 * Entry names, slash commands, file paths and the error messages that quote them come from plugin
 * directories and cloned repositories, so any of them can hold such a link. Text like that goes
 * through safeNotificationText before it is put in a message, which puts a space into each `](`
 * and leaves every other character as it was: a path keeps its backslashes and a name its
 * parentheses, because the renderer shows a backslash escape as a backslash. The wrappers below do
 * the same to the finished message, which also covers a `]` at the end of one text and a `(` at the
 * start of the next. notification-guard.test.ts fails the build for a `show*Message` call outside
 * this file and for a message built from a string that did not pass through safeNotificationText.
 *
 * Nothing here builds a `command:` URI, and nothing may: the text is for reading.
 */

/** Characters of the original text a message may carry; a longer text is cut and ends in an ellipsis. */
const MAX_TEXT_LENGTH = 200;
const ELLIPSIS = '\u2026';
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

/**
 * What hides or reorders the text next to it: the bidirectional embeddings, overrides and isolates
 * that make `invoice<RLO>gnp.exe` read as `invoiceexe.png`, and the characters that draw nothing (soft
 * hyphen, zero-width space, word joiner, byte order mark). The zero-width joiner and non-joiner stay:
 * some scripts and emoji are spelled with them.
 */
const HIDING_OR_REORDERING = /[\u00ad\u200b\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** White space of every kind (newlines, tabs, line and paragraph separators) and the control characters. */
const SPACE_OR_CONTROL_RUNS = /[\s\u0000-\u001f\u007f-\u009f]+/g;

/** The two characters a link cannot do without, back to back. */
const LINK_JOINT = /\]\(/g;

/** What goes between them: a space, which shows and which no renderer reads as part of a link. */
const SPLIT_JOINT = '] (';

function endsInsideSurrogatePair(text: string): boolean {
  const last = text.charCodeAt(text.length - 1);
  return last >= HIGH_SURROGATE_START && last <= HIGH_SURROGATE_END;
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const cut = text.slice(0, MAX_TEXT_LENGTH);
  return `${endsInsideSurrogatePair(cut) ? cut.slice(0, -1) : cut}${ELLIPSIS}`;
}

/** `text` with a space in each `](`, so nothing in it is a link however it is put together. */
function withoutLinkJoints(text: string): string {
  return text.replace(LINK_JOINT, SPLIT_JOINT);
}

/**
 * `text` as one short line of plain text that no notification renderer can read as a link: hiding
 * and reordering characters are dropped, white space and control characters become a single space,
 * each `](` gets a space, and the text is cut to MAX_TEXT_LENGTH characters. Nothing else is
 * changed. A value that is not a string (a plugin can hand back anything) is shown as its text form,
 * and `null` and `undefined` as nothing.
 */
export function safeNotificationText(text: string): string {
  const plain = typeof text === 'string' ? text : String(text ?? '');
  const oneLine = plain
    .replace(HIDING_OR_REORDERING, '')
    .replace(SPACE_OR_CONTROL_RUNS, ' ')
    .trim();
  return truncate(withoutLinkJoints(oneLine));
}

export function notifyInfo<T extends string>(
  message: string,
  ...items: T[]
): Thenable<T | undefined> {
  return vscode.window.showInformationMessage(withoutLinkJoints(message), ...items);
}

export function notifyWarn<T extends string>(
  message: string,
  ...items: T[]
): Thenable<T | undefined> {
  return vscode.window.showWarningMessage(withoutLinkJoints(message), ...items);
}

export function notifyError<T extends string>(
  message: string,
  ...items: T[]
): Thenable<T | undefined> {
  return vscode.window.showErrorMessage(withoutLinkJoints(message), ...items);
}
