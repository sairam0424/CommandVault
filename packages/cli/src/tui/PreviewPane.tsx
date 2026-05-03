import React from 'react';
import { Box, Text } from 'ink';
import type { VaultEntry } from '@commandvault/core';
import { getContentExcerpt } from '@commandvault/core';

interface Props {
  readonly entry: VaultEntry | null;
  readonly query: string;
  readonly scrollTop: number;
  readonly height: number;
  readonly width: number;
}

function MetadataFallback({ entry, width }: { entry: VaultEntry; width: number }) {
  const maxWidth = width - 4;
  const rows: [string, string][] = [
    ['Type', entry.type],
    ['Source', entry.source],
    ['Tags', entry.tags.join(', ') || '(none)'],
    ['Used', `${entry.usageCount} times`],
    ['File', entry.filePath],
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor italic>
        No content — showing metadata
      </Text>
      {rows.map(([k, v]) => (
        <Box key={k} gap={1}>
          <Text bold color="cyan">
            {k.padEnd(8)}
          </Text>
          <Text>{v.slice(0, maxWidth)}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function PreviewPane({ entry, query, scrollTop, height, width }: Props) {
  if (!entry) {
    return (
      <Box
        borderStyle="single"
        borderColor="gray"
        width={width}
        height={height}
        paddingX={1}
        justifyContent="center"
        alignItems="center"
      >
        <Text dimColor>Select a result to preview</Text>
      </Box>
    );
  }

  if (!entry.content.trim()) {
    return (
      <Box borderStyle="single" borderColor="gray" width={width} height={height}>
        <MetadataFallback entry={entry} width={width} />
      </Box>
    );
  }

  const { lines, matchLine } = getContentExcerpt(entry.content, query, height * 2);
  const clampedScrollTop = Math.min(scrollTop, Math.max(0, lines.length - height));
  const visible = lines.slice(clampedScrollTop, clampedScrollTop + height);

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      width={width}
      height={height}
      flexDirection="column"
      paddingX={1}
      overflow="hidden"
    >
      {visible.map((line, i) => {
        const absIdx = clampedScrollTop + i;
        const isMatch = matchLine !== null && absIdx === matchLine;
        return (
          <Text key={i} color={isMatch ? 'yellow' : undefined} bold={isMatch}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
