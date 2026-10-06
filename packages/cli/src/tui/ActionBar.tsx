import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../helpers.js';
import { singleLine } from './text.js';

interface Props {
  readonly errorMessage: string | null;
  readonly width: number;
  readonly hasSelection: boolean;
  readonly showPreview: boolean;
}

// Letters and brackets type into the search box, so every action lives on a
// Ctrl chord or a non-printable key. Each list runs from the full labels to
// the shortest form that still names the way out; the bar shows the longest
// form that fits on one line.
const NO_PREVIEW_SEARCH_HINTS = [
  '↵ Copy  ^O Open  ^F Fav  ^C Quit',
  '↵ Copy  ^O Open  ^C Quit',
  '^C Quit',
];
const SEARCH_HINTS = [
  '[↵ Copy]  [^O Open]  [^F ★ Fav]  [PgUp/PgDn Preview]  [^C Quit]',
  '↵ Copy  ^O Open  ^F Fav  PgUp/PgDn Preview  ^C Quit',
  ...NO_PREVIEW_SEARCH_HINTS,
];
const QUIT_HINTS = ['[^C Quit]', '^C Quit'];

// The box border takes one column on each side and paddingX takes another.
const BOX_CHROME_COLUMNS = 4;

function hintsFor(hasSelection: boolean, showPreview: boolean): readonly string[] {
  if (!hasSelection) return QUIT_HINTS;
  // Without the preview pane there is nothing for PgUp/PgDn to scroll.
  return showPreview ? SEARCH_HINTS : NO_PREVIEW_SEARCH_HINTS;
}

/** The longest hint that fits in `available` columns; the shortest one, cut, if none does. */
function fitHint(hints: readonly string[], available: number): string {
  const fitting = hints.find((hint) => hint.length <= available);
  if (fitting) return fitting;
  return truncate(hints[hints.length - 1] ?? '', available);
}

export function ActionBar({ errorMessage, width, hasSelection, showPreview }: Props) {
  const available = Math.max(1, width - BOX_CHROME_COLUMNS);
  return (
    <Box borderStyle="single" borderColor="gray" width={width} paddingX={1}>
      {errorMessage ? (
        // A name or an error can hold wide characters or line breaks; Ink cuts by columns and
        // singleLine keeps the message on the one row the frame arithmetic allows.
        <Text color="red" wrap="truncate-end">
          {singleLine(errorMessage)}
        </Text>
      ) : (
        <Text dimColor>{fitHint(hintsFor(hasSelection, showPreview), available)}</Text>
      )}
    </Box>
  );
}
