import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../helpers.js';

interface Props {
  readonly errorMessage: string | null;
  readonly width: number;
  readonly mode: 'search' | 'filter';
  readonly hasSelection: boolean;
  readonly showPreview: boolean;
}

// Letters and brackets type into the search box, so every action lives on a
// Ctrl chord or a non-printable key. Each list runs from the full labels to
// the shortest form that still names the way out; the bar shows the longest
// form that fits on one line.
const NO_PREVIEW_SEARCH_HINTS = [
  '↵ Copy  ^O Open  ^F Fav  Tab Filter  ^C Quit',
  '↵ Copy  ^O Open  ^F Fav  ^C Quit',
  '↵ Copy  ^O Open  ^C Quit',
  '^C Quit',
];
const SEARCH_HINTS = [
  '[↵ Copy]  [^O Open]  [^F ★ Fav]  [Tab Filter]  [PgUp/PgDn Preview]  [^C Quit]',
  '↵ Copy  ^O Open  ^F Fav  Tab Filter  PgUp/PgDn Preview  ^C Quit',
  ...NO_PREVIEW_SEARCH_HINTS,
];
const QUIT_HINTS = ['[^C Quit]', '^C Quit'];
const FILTER_HINTS = [
  '[↑↓ Navigate]  [↵ Toggle]  [Tab/Esc Done]',
  '↑↓ Navigate  ↵ Toggle  Tab Done',
  'Tab Done',
];

// The box border takes one column on each side and paddingX takes another.
const BOX_CHROME_COLUMNS = 4;

function hintsFor(
  mode: Props['mode'],
  hasSelection: boolean,
  showPreview: boolean,
): readonly string[] {
  if (mode === 'filter') return FILTER_HINTS;
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

export function ActionBar({ errorMessage, width, mode, hasSelection, showPreview }: Props) {
  const available = Math.max(1, width - BOX_CHROME_COLUMNS);
  return (
    <Box borderStyle="single" borderColor="gray" width={width} paddingX={1}>
      {errorMessage ? (
        <Text color="red">{truncate(errorMessage, available)}</Text>
      ) : (
        <Text dimColor>{fitHint(hintsFor(mode, hasSelection, showPreview), available)}</Text>
      )}
    </Box>
  );
}
