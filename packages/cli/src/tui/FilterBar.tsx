import React from 'react';
import { Box, Text } from 'ink';
import type { EntryType, EntrySource } from '@commandvault/core';

const TYPES: EntryType[] = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'];
const SOURCES: EntrySource[] = ['official', 'community', 'gstack', 'bmad', 'superpowers', 'custom'];

interface Props {
  readonly activeType: EntryType | null;
  readonly activeSource: EntrySource | null;
  readonly onSelectType: (type: EntryType | null) => void;
  readonly onSelectSource: (source: EntrySource | null) => void;
  readonly width: number;
}

export function FilterBar({ activeType, activeSource, onSelectType, onSelectSource, width }: Props) {
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box gap={1} flexWrap="wrap">
        <Text dimColor>Type: </Text>
        {TYPES.map((t) => (
          <Text
            key={t}
            color={activeType === t ? 'black' : 'cyan'}
            backgroundColor={activeType === t ? 'cyan' : undefined}
            bold={activeType === t}
          >
            {` ${t} `}
          </Text>
        ))}
      </Box>
      <Box gap={1} flexWrap="wrap">
        <Text dimColor>Source: </Text>
        {SOURCES.map((s) => (
          <Text
            key={s}
            color={activeSource === s ? 'black' : 'magenta'}
            backgroundColor={activeSource === s ? 'magenta' : undefined}
            bold={activeSource === s}
          >
            {` ${s} `}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
