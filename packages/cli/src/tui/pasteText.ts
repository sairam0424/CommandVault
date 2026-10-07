// CSI: ESC [ parameter bytes, intermediate bytes, one final byte (ECMA-48 5.4).
const CSI_SEQUENCE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// OSC: ESC ] text, ended by BEL or by ST (ESC \).
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LONE_ESCAPE = /\x1b/g;
// C0 controls (CR, LF, TAB included), DEL, C1 controls, Unicode line and paragraph separators.
const BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const WHITESPACE_RUN = /\s+/g;
const SPACE = ' ';

/**
 * Pasted text flattened to one line, edges kept: a leading or trailing space says the text began
 * or ended on a word boundary, which matters when a paste arrives in pieces.
 */
export function flattenPaste(raw: string): string {
  return raw
    .replace(CSI_SEQUENCE, '')
    .replace(OSC_SEQUENCE, '')
    .replace(LONE_ESCAPE, '')
    .replace(BREAK_OR_CONTROL, SPACE)
    .replace(WHITESPACE_RUN, SPACE);
}

/**
 * Pasted text as one line for the search box. The box holds a query, so line breaks, tabs and
 * other control characters are word separators, and escape sequences a clipboard may carry
 * (colours, titles, hyperlinks) are dropped whole rather than typed as their printable tail.
 */
export function pasteText(raw: string): string {
  return flattenPaste(raw).trim();
}
