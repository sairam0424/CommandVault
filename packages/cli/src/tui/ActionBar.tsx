import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  readonly errorMessage: string | null;
  readonly width: number;
  readonly mode: 'search' | 'filter';
  readonly hasSelection: boolean;
}

// Letters and brackets type into the search box, so every action lives on a
// Ctrl chord or a non-printable key.
const SEARCH_HINTS =
  '[↵ Copy]  [^O Open]  [^F ★ Fav]  [Tab Filter]  [PgUp/PgDn Preview]  [^C Quit]';
const QUIT_HINT = '[^C Quit]';
const FILTER_HINTS = '[↑↓ Navigate]  [↵ Toggle]  [Tab/Esc Done]';

function hintsFor(mode: Props['mode'], hasSelection: boolean): string {
  if (mode === 'filter') return FILTER_HINTS;
  return hasSelection ? SEARCH_HINTS : QUIT_HINT;
}

export function ActionBar({ errorMessage, width, mode, hasSelection }: Props) {
  return (
    <Box borderStyle="single" borderColor="gray" width={width} paddingX={1}>
      {errorMessage ? (
        <Text color="red">{errorMessage}</Text>
      ) : (
        <Text dimColor>{hintsFor(mode, hasSelection)}</Text>
      )}
    </Box>
  );
}
