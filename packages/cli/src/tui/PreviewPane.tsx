import React from 'react';
import { Box, Text } from 'ink';
import type { VaultEntry } from '@commandvault/core';
import { previewContent, previewTextRows } from './previewExcerpt.js';
import { entryTag, singleLine } from './text.js';

interface Props {
  readonly entry: VaultEntry | null;
  readonly query: string;
  readonly scrollTop: number;
  readonly height: number;
  readonly width: number;
}

function MetadataFallback({ entry }: { entry: VaultEntry }) {
  const rows: [string, string][] = [
    ['Type', entry.type],
    ['Source', entry.source],
    ['Tags', singleLine(entry.tags.join(', ')) || '(none)'],
    ['Used', `${entry.usageCount} times`],
    ['File', singleLine(entry.filePath)],
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
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{v}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** The line under the top border: what the entry is and which file it is read from. */
function Header({ entry }: { entry: VaultEntry }) {
  return (
    <Box gap={2}>
      <Box flexShrink={0}>
        <Text dimColor>{entryTag(entry)}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-start">
          {singleLine(entry.filePath)}
        </Text>
      </Box>
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

  // safe-text: an emptiness test; the content is drawn through previewContent
  if (!entry.content.trim()) {
    return (
      <Box borderStyle="single" borderColor="gray" width={width} height={height}>
        <MetadataFallback entry={entry} />
      </Box>
    );
  }

  const { lines, matchLine } = previewContent(entry.content, query);
  // Each line is drawn on one row (long ones are cut), so the rows inside the border are the
  // number of lines shown; more Text rows than that get squeezed by the flex layout, which
  // drops lines from the middle of the preview.
  const textRows = previewTextRows(height);
  const clampedScrollTop = Math.min(scrollTop, Math.max(0, lines.length - textRows));
  const visible = lines.slice(clampedScrollTop, clampedScrollTop + textRows);

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
      <Header entry={entry} />
      {visible.map((line, i) => {
        const absIdx = clampedScrollTop + i;
        const isMatch = matchLine !== null && absIdx === matchLine;
        return (
          <Text
            key={absIdx}
            wrap="truncate-end"
            color={isMatch ? 'yellow' : undefined}
            bold={isMatch}
          >
            {line || ' '}
          </Text>
        );
      })}
    </Box>
  );
}
