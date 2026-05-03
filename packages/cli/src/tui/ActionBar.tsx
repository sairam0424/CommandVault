import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  readonly errorMessage: string | null;
  readonly width: number;
  readonly mode: 'search' | 'filter';
  readonly hasSelection: boolean;
}

const SEARCH_HINTS = '[↵ Copy]  [o Open]  [f ★ Fav]  [Tab Filter]  [[ ]] Preview  [q Quit]';
const FILTER_HINTS = '[↑↓ Navigate]  [↵ Toggle]  [Tab/Esc Done]';

export function ActionBar({ errorMessage, width, mode, hasSelection }: Props) {
  return (
    <Box borderStyle="single" borderColor="gray" width={width} paddingX={1}>
      {errorMessage ? (
        <Text color="red">{errorMessage}</Text>
      ) : (
        <Text dimColor>
          {mode === 'filter' ? FILTER_HINTS : (hasSelection ? SEARCH_HINTS : '[q Quit]')}
        </Text>
      )}
    </Box>
  );
}
