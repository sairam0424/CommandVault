import React from 'react';
import { Box, Text } from 'ink';
import type { SearchResult } from '@commandvault/core';
import { truncate } from '../helpers.js';

interface Props {
  readonly results: SearchResult[];
  readonly selectedIndex: number;
  readonly scrollTop: number;
  readonly visibleCount: number;
  readonly width: number;
}

export function ResultsList({ results, selectedIndex, scrollTop, visibleCount, width }: Props) {
  if (results.length === 0) {
    return (
      <Box width={width} paddingX={1} flexDirection="column">
        <Text dimColor>No matches. Try a different query or press Tab to filter.</Text>
        <Text dimColor>Run `vault doctor` if entries are missing.</Text>
      </Box>
    );
  }

  const visible = results.slice(scrollTop, scrollTop + visibleCount);
  const nameWidth = width - 4;

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((r, visibleIdx) => {
        const absoluteIdx = scrollTop + visibleIdx;
        const isSelected = absoluteIdx === selectedIndex;
        return (
          <Box key={r.entry.id} flexDirection="column" paddingX={1}>
            <Text inverse={isSelected} color={isSelected ? undefined : 'cyan'} bold={isSelected}>
              {isSelected ? '▶ ' : '  '}
              {truncate(r.entry.name, nameWidth - 2)}
            </Text>
            <Text dimColor>
              {'  '}
              {truncate(r.entry.description || '(no description)', nameWidth - 2)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
