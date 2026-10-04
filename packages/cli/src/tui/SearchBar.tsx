import React from 'react';
import { Box, Text } from 'ink';
import type { EntryType, EntrySource } from '@commandvault/core';
import { QueryInput } from './QueryInput.js';

interface Props {
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly filterType: EntryType | null;
  readonly filterSource: EntrySource | null;
  readonly width: number;
}

export function SearchBar({ query, onQueryChange, filterType, filterSource, width }: Props) {
  return (
    <Box borderStyle="single" borderColor="cyan" width={width} paddingX={1}>
      <Text color="cyan" bold>
        {'> '}
      </Text>
      <Box flexGrow={1}>
        <QueryInput value={query} onChange={onQueryChange} placeholder="Search commands..." />
      </Box>
      {filterType && <Text color="yellow">{` [${filterType}]`}</Text>}
      {filterSource && <Text color="magenta">{` [${filterSource}]`}</Text>}
    </Box>
  );
}
