import type { VaultEntry } from '@commandvault/core';

const CONTROL_RUN = /[\u0000-\u001f\u007f]+/g;
const TAB = /\t/g;
const TAB_AS_SPACES = '    ';

/** Text for one terminal row: any run of control characters, a line break included, becomes a space. */
export function singleLine(text: string): string {
  return text.replace(CONTROL_RUN, ' ').trim();
}

/**
 * One line of file content made safe to draw: tabs become spaces (a tab's width is not known to
 * the layout) and every other control character, an escape sequence's lead byte included, is dropped.
 */
export function printable(line: string): string {
  return line.replace(TAB, TAB_AS_SPACES).replace(CONTROL_RUN, '');
}

/** `[type · source]`: what tells two entries with the same name apart. */
export function entryTag(entry: Pick<VaultEntry, 'type' | 'source'>): string {
  return `[${entry.type} · ${entry.source}]`;
}

// East Asian wide blocks and emoji presentation: what Ink counts as two columns. A character
// listed as one column that is really two would overflow the row, so the list leans wide.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f19a],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Terminal columns one character takes: 2 for East Asian wide characters and emoji, else 1. */
export function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}
