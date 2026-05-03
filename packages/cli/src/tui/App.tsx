import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdout, useApp } from 'ink';
import { execFileSync } from 'node:child_process';
import type { VaultEntry, EntryType, EntrySource } from '@commandvault/core';
import type { Vault } from '@commandvault/core';
import { SearchBar } from './SearchBar.js';
import { ResultsList } from './ResultsList.js';
import { PreviewPane } from './PreviewPane.js';
import { ActionBar } from './ActionBar.js';
import { FilterBar } from './FilterBar.js';
import { useVaultSearch } from './hooks/useVaultSearch.js';
import { useScroll } from './hooks/useScroll.js';
import { usePreviewScroll } from './hooks/usePreviewScroll.js';

const MIN_PREVIEW_WIDTH = 80;
const MIN_USABLE_WIDTH = 60;
const RESULTS_WIDTH_RATIO = 0.38;
const MIN_RESULTS_WIDTH = 28;
const SEARCH_BAR_HEIGHT = 3;
const ACTION_BAR_HEIGHT = 2;
const ERROR_CLEAR_MS = 3000;

interface Props {
  readonly vault: Vault;
}

export function App({ vault }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const columns = stdout?.columns ?? 100;
  const rows = stdout?.rows ?? 30;

  const bodyHeight = rows - SEARCH_BAR_HEIGHT - ACTION_BAR_HEIGHT;
  const visibleCount = Math.max(1, Math.floor(bodyHeight / 2));
  const showPreview = columns >= MIN_PREVIEW_WIDTH;
  const isTooNarrow = columns < MIN_USABLE_WIDTH;
  const resultsWidth = showPreview
    ? Math.max(MIN_RESULTS_WIDTH, Math.floor(columns * RESULTS_WIDTH_RATIO))
    : columns;
  const previewWidth = showPreview ? columns - resultsWidth - 1 : 0;

  const [query, setQuery] = useState('');
  const [filterType, setFilterType] = useState<EntryType | null>(null);
  const [filterSource, setFilterSource] = useState<EntrySource | null>(null);
  const [mode, setMode] = useState<'search' | 'filter'>('search');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleError = useCallback((err: Error) => {
    setErrorMessage(err.message);
  }, []);

  const results = useVaultSearch(vault, query, filterType, filterSource, handleError);

  const scroll = useScroll(results.length, visibleCount);
  const selectedEntry: VaultEntry | null = results[scroll.selectedIndex]?.entry ?? null;

  // Estimate content line count for preview scroll — use 200 as a reasonable default
  const contentLineCount = selectedEntry ? selectedEntry.content.split('\n').length : 0;
  const previewScroll = usePreviewScroll(contentLineCount, bodyHeight);

  // Reset scroll when filters/query change
  useEffect(() => {
    scroll.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filterType, filterSource]);

  // Reset preview scroll when selected entry changes
  useEffect(() => {
    previewScroll.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroll.selectedIndex]);

  // Auto-clear error messages
  useEffect(() => {
    if (!errorMessage) return;
    const timer = setTimeout(() => setErrorMessage(null), ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [errorMessage]);

  useInput((input, key) => {
    // Quit
    if (input === 'q' || key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Escape: clear query or exit
    if (key.escape) {
      if (query) {
        setQuery('');
      } else {
        exit();
      }
      return;
    }

    // Navigation
    if (key.upArrow) {
      scroll.moveUp();
      return;
    }
    if (key.downArrow) {
      scroll.moveDown();
      return;
    }

    // Tab: toggle mode
    if (key.tab) {
      setMode((m) => (m === 'search' ? 'filter' : 'search'));
      return;
    }

    // Preview scroll
    if (input === '[') {
      previewScroll.scrollUp();
      return;
    }
    if (input === ']') {
      previewScroll.scrollDown();
      return;
    }

    // Enter: copy slash command to clipboard
    if (key.return && selectedEntry) {
      const slashCmd = vault.getSlashCommand(selectedEntry);
      import('clipboardy')
        .then((mod) => {
          const clipboard = mod.default ?? mod;
          return (clipboard as { write: (s: string) => Promise<void> }).write(slashCmd);
        })
        .then(() => {
          vault.recordUsage(selectedEntry.id);
          setErrorMessage(`Copied: ${slashCmd}`);
        })
        .catch((err: unknown) => {
          setErrorMessage(`Clipboard error: ${err instanceof Error ? err.message : String(err)}`);
        });
      return;
    }

    // 'o': open file in $EDITOR
    if (input === 'o' && selectedEntry) {
      const editor = process.env['EDITOR'] ?? 'vi';
      try {
        execFileSync(editor, [selectedEntry.filePath], { stdio: 'ignore' });
      } catch (err) {
        setErrorMessage(`Editor error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // 'f': toggle favorite
    if (input === 'f' && selectedEntry) {
      const isFav = vault.toggleFavorite(selectedEntry.id);
      setErrorMessage(isFav ? `★ Added to favorites: ${selectedEntry.name}` : `☆ Removed from favorites: ${selectedEntry.name}`);
      return;
    }
  });

  if (isTooNarrow) {
    return (
      <Box>
        <Text color="yellow">
          Terminal too narrow ({columns} cols). Minimum: {MIN_USABLE_WIDTH}.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <SearchBar
        query={query}
        onQueryChange={setQuery}
        filterType={filterType}
        filterSource={filterSource}
        width={columns}
      />
      {mode === 'filter' && (
        <FilterBar
          activeType={filterType}
          activeSource={filterSource}
          onSelectType={setFilterType}
          onSelectSource={setFilterSource}
          width={columns}
        />
      )}
      <Box flexDirection="row" height={bodyHeight}>
        <ResultsList
          results={results}
          selectedIndex={scroll.selectedIndex}
          scrollTop={scroll.scrollTop}
          visibleCount={visibleCount}
          width={resultsWidth}
        />
        {showPreview && (
          <>
            <Text>│</Text>
            <PreviewPane
              entry={selectedEntry}
              query={query}
              scrollTop={previewScroll.scrollTop}
              height={bodyHeight}
              width={previewWidth}
            />
          </>
        )}
      </Box>
      <ActionBar
        errorMessage={errorMessage}
        width={columns}
        mode={mode}
        hasSelection={selectedEntry !== null}
      />
    </Box>
  );
}
