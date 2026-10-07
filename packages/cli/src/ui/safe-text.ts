/**
 * Terminal-safe text. Entry fields come from third-party skill files, imported bundles and remote
 * registries, and a terminal obeys whatever escape sequence it is handed: a name can retitle the
 * window, clear the screen, plant a spoofed hyperlink or write the clipboard. `safeText` is the
 * one primitive every printed entry field goes through; `toDisplay` applies it to a whole record.
 *
 * Both passes only delete; nothing is normalised, re-encoded or width-adjusted. Emoji, CJK,
 * combining marks, ZWJ and NBSP pass through untouched.
 */

// Pass 1: whole sequences, with their 7-bit (ESC x) and 8-bit (C1) introducers alike.
//  - CSI: ESC [ or U+009B, parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, one final 0x40-0x7E.
//  - OSC: ESC ] or U+009D, up to ST (ESC \ or U+009C) or BEL, or to the end of the string.
//  - DCS (ESC P / U+0090), SOS (ESC X / U+0098), PM (ESC ^ / U+009E), APC (ESC _ / U+009F):
//    up to ST or the end of the string.
//  - Any other ESC: intermediates 0x20-0x2F and one final 0x30-0x7E (ESC c, ESC ( B, ...).
// An ESC inside an OSC/DCS body that is not part of ST aborts that sequence, as a terminal would,
// and is then handled on its own.
const SEQUENCE = new RegExp(
  [
    '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]',
    '(?:\\u001b\\]|\\u009d)[^\\u0007\\u009c\\u001b]*(?:\\u0007|\\u009c|\\u001b\\\\|$)',
    '(?:\\u001b[PX^_]|[\\u0090\\u0098\\u009e\\u009f])[^\\u009c\\u001b]*(?:\\u009c|\\u001b\\\\|$)',
    '\\u001b[ -/]*[0-~]',
  ].join('|'),
  'g',
);

// Between the passes: a run of line breaks becomes one space, so the words of a multi-line
// description (a YAML `|` block) stay apart on the single line the result is. The same rule the
// TUI's `singleLine` applies to every control run.
const LINE_BREAK_RUN = /[\r\n]+/g;
const LINE_BREAK_REPLACEMENT = ' ';

// Pass 2: single characters that steer the terminal or the reader.
//  - C0 controls except TAB (\n and \r are already a space by now), DEL.
//  - C1 controls U+0080-U+009F (a lone introducer, or a C1 the terminal would act on).
//  - U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR.
//  - Bidi embedding/override controls U+202A-U+202E and isolates U+2066-U+2069.
const CONTROL_CHARACTER =
  /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `s` with every terminal escape sequence and control character deleted and each run of line
 * breaks turned into one space. Single-line: callers that need line structure split first.
 * Idempotent: no introducer survives pass 2 and a space is kept as it is.
 */
export function safeText(s: string): string {
  return s
    .replace(SEQUENCE, '')
    .replace(LINE_BREAK_RUN, LINE_BREAK_REPLACEMENT)
    .replace(CONTROL_CHARACTER, '');
}

declare const SAFE: unique symbol;

/** A read-only view of `T` whose every string has been through {@link safeText}. */
export type Display<T> = Readonly<T> & { readonly [SAFE]: true };

/** Nesting beyond this is replaced by an empty container rather than copied raw. */
const MAX_DEPTH = 8;

function cleanValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return safeText(value);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [safeText(key), cleanValue(item, depth + 1)]),
  );
}

/**
 * A deep copy of `record` (new objects, arrays included) with every string key and value passed
 * through {@link safeText}; numbers, booleans and Dates are kept as they are.
 */
export function toDisplay<T extends object>(record: T): Display<T> {
  return cleanValue(record, 0) as Display<T>;
}
