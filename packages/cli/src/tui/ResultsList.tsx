import React from 'react';
import { Box, Text } from 'ink';
import type { SearchResult, VaultEntry } from '@commandvault/core';
import { entryTag, singleLine } from './text.js';

interface Props {
  readonly results: SearchResult[];
  readonly selectedIndex: number;
  readonly scrollTop: number;
  readonly visibleCount: number;
  readonly width: number;
}

const SELECTED_MARKER = '▶ ';
const NO_MARKER = '  ';
const FAVORITE_MARK = '★ ';
const NO_DESCRIPTION = '(no description)';

function Row({ entry, isSelected }: { readonly entry: VaultEntry; readonly isSelected: boolean }) {
  const star = entry.favorite ? FAVORITE_MARK : '';
  const description = singleLine(entry.description) || NO_DESCRIPTION;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text
          wrap="truncate-end"
          inverse={isSelected}
          color={isSelected ? undefined : 'cyan'}
          bold={isSelected}
        >
          {`${isSelected ? SELECTED_MARKER : NO_MARKER}${star}${singleLine(entry.name)}`}
        </Text>
        {entry.usageCount > 0 && (
          <Box flexShrink={0}>
            <Text dimColor>{` ×${entry.usageCount}`}</Text>
          </Box>
        )}
      </Box>
      <Text wrap="truncate-end" dimColor>
        {`${NO_MARKER}${entryTag(entry)}  ${description}`}
      </Text>
    </Box>
  );
}

export function ResultsList({ results, selectedIndex, scrollTop, visibleCount, width }: Props) {
  if (results.length === 0) {
    return (
      <Box width={width} paddingX={1} flexDirection="column">
        <Text dimColor>No matches. Try a different query.</Text>
        <Text dimColor>Run `vault doctor` if entries are missing.</Text>
      </Box>
    );
  }

  const visible = results.slice(scrollTop, scrollTop + visibleCount);

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((r, visibleIdx) => (
        <Row
          key={r.entry.id}
          entry={r.entry}
          isSelected={scrollTop + visibleIdx === selectedIndex}
        />
      ))}
    </Box>
  );
}
