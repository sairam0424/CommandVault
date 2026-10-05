import React from 'react';
import { Box, Text } from 'ink';
import type { EntryType, EntrySource } from '@commandvault/core';
import { QueryInput } from './QueryInput.js';

interface Props {
  readonly query: string;
  readonly cursor: number;
  readonly filterType: EntryType | null;
  readonly filterSource: EntrySource | null;
  readonly width: number;
}

// The box border and its padding take two columns on each side.
const BOX_CHROME_COLUMNS = 4;
const PROMPT = '> ';

export function SearchBar({ query, cursor, filterType, filterSource, width }: Props) {
  const typeTag = filterType ? ` [${filterType}]` : '';
  const sourceTag = filterSource ? ` [${filterSource}]` : '';
  const capacity = width - BOX_CHROME_COLUMNS - PROMPT.length - typeTag.length - sourceTag.length;
  return (
    <Box borderStyle="single" borderColor="cyan" width={width} paddingX={1}>
      <Text color="cyan" bold>
        {PROMPT}
      </Text>
      <Box flexGrow={1}>
        <QueryInput
          value={query}
          cursor={cursor}
          placeholder="Search commands..."
          capacity={capacity}
        />
      </Box>
      {filterType && <Text color="yellow">{typeTag}</Text>}
      {filterSource && <Text color="magenta">{sourceTag}</Text>}
    </Box>
  );
}
