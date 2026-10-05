import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import type { Key } from 'ink';
import type { VaultEntry, EntryType, EntrySource } from '@commandvault/core';
import type { Vault } from '@commandvault/core';
import { SearchBar } from './SearchBar.js';
import { ResultsList } from './ResultsList.js';
import { PreviewPane } from './PreviewPane.js';
import { ActionBar } from './ActionBar.js';
import { FilterBar } from './FilterBar.js';
import { openInEditor } from './openInEditor.js';
import { useVaultSearch } from './hooks/useVaultSearch.js';
import { useScroll } from './hooks/useScroll.js';
import { usePreviewScroll } from './hooks/usePreviewScroll.js';
import { useKeyEvents, STOP_KEYS } from './hooks/useKeyEvents.js';
import { useQueryEditor } from './hooks/useQueryEditor.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { previewLineCount, previewTextRows } from './previewExcerpt.js';

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
  const { columns, rows } = useTerminalSize();

  const bodyHeight = rows - SEARCH_BAR_HEIGHT - ACTION_BAR_HEIGHT;
  const visibleCount = Math.max(1, Math.floor(bodyHeight / 2));
  const previewRows = previewTextRows(bodyHeight);
  const showPreview = columns >= MIN_PREVIEW_WIDTH;
  const isTooNarrow = columns < MIN_USABLE_WIDTH;
  const resultsWidth = showPreview
    ? Math.max(MIN_RESULTS_WIDTH, Math.floor(columns * RESULTS_WIDTH_RATIO))
    : columns;
  const previewWidth = showPreview ? columns - resultsWidth - 1 : 0;

  const editor = useQueryEditor();
  const query = editor.value;
  const [filterType, setFilterType] = useState<EntryType | null>(null);
  const [filterSource, setFilterSource] = useState<EntrySource | null>(null);
  const [mode, setMode] = useState<'search' | 'filter'>('search');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleError = useCallback((err: Error) => {
    setErrorMessage(err.message);
  }, []);

  const { results, resultsFor } = useVaultSearch(
    vault,
    query,
    filterType,
    filterSource,
    handleError,
  );

  const {
    selectedIndex,
    scrollTop,
    moveUp,
    moveDown,
    reset: scrollReset,
    getSelectedIndex,
  } = useScroll(results.length, visibleCount);
  const selectedEntry: VaultEntry | null = results[selectedIndex]?.entry ?? null;

  const {
    scrollTopFor: previewScrollTopFor,
    pageUp: previewPageUp,
    pageDown: previewPageDown,
    reset: previewReset,
  } = usePreviewScroll(previewRows, previewRows);

  // Key handlers run several times per render when a read holds several keys,
  // so they look the selection up here rather than in the rendered values. Text
  // typed earlier in the read has not been searched yet; resultsFor runs that
  // search, so a key never acts on the list of the previous query.
  const listNow = () => resultsFor(editor.getValue());
  const entryAtSelection = (): VaultEntry | null => {
    const list = listNow();
    return list[getSelectedIndex(list.length)]?.entry ?? null;
  };
  const previewTarget = () => {
    const entry = entryAtSelection();
    const lineCount = entry ? previewLineCount(entry.content, editor.getValue(), bodyHeight) : 0;
    return { id: entry?.id ?? null, lineCount };
  };

  // Reset list scroll when a filter changes (query edits reset it as they are typed)
  useEffect(() => {
    scrollReset();
  }, [filterType, filterSource, scrollReset]);

  // Auto-clear error messages
  useEffect(() => {
    if (!errorMessage) return;
    const timer = setTimeout(() => setErrorMessage(null), ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [errorMessage]);

  const restartList = () => {
    scrollReset();
    previewReset();
  };

  // Moving the selection or page scrolling: returns true when the key was one of those.
  const handleNavigationKey = (key: Key): boolean => {
    if (key.upArrow || key.downArrow) {
      // Bound the move by the list the typed text finds, not the one last rendered.
      const length = listNow().length;
      const before = getSelectedIndex(length);
      if (key.upArrow) moveUp(length);
      else moveDown(length);
      // A key that cannot move the selection (first or last row) leaves the preview alone.
      if (getSelectedIndex(length) !== before) previewReset();
      return true;
    }
    if (key.tab) {
      setMode((m) => (m === 'search' ? 'filter' : 'search'));
      return true;
    }
    if (key.pageUp) {
      previewPageUp(previewTarget());
      return true;
    }
    if (key.pageDown) {
      previewPageDown(previewTarget());
      return true;
    }
    return false;
  };

  // Enter, Ctrl+O and Ctrl+F act on the selected entry: returns true when one of them did.
  const handleEntryKey = (input: string, key: Key): boolean => {
    // Any other key is text for the box; resolving an entry would search before the debounce.
    const isEntryKey = key.return || (key.ctrl && (input === 'o' || input === 'f'));
    if (!isEntryKey) return false;
    const entry = entryAtSelection();
    if (!entry) return false;

    // Enter: copy slash command to clipboard
    if (key.return) {
      const slashCmd = vault.getSlashCommand(entry);
      import('clipboardy')
        .then((mod) => {
          const clipboard = mod.default ?? mod;
          return (clipboard as { write: (s: string) => Promise<void> }).write(slashCmd);
        })
        .then(() => {
          vault.recordUsage(entry.id);
          setErrorMessage(`Copied: ${slashCmd}`);
        })
        .catch((err: unknown) => {
          setErrorMessage(`Clipboard error: ${err instanceof Error ? err.message : String(err)}`);
        });
      return true;
    }

    // Ctrl+O: open file in $EDITOR
    if (key.ctrl && input === 'o') {
      try {
        openInEditor(entry.filePath);
      } catch (err) {
        setErrorMessage(`Editor error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    // Ctrl+F: toggle favorite
    if (key.ctrl && input === 'f') {
      const isFav = vault.toggleFavorite(entry.id);
      setErrorMessage(
        isFav ? `★ Added to favorites: ${entry.name}` : `☆ Removed from favorites: ${entry.name}`,
      );
      return true;
    }
    return false;
  };

  useKeyEvents((input, key) => {
    // Printable keys type into the search box, so actions use Ctrl chords and
    // non-printable keys only. Ctrl+C always quits and is never typed.
    if (key.ctrl && input === 'c') {
      exit();
      return STOP_KEYS;
    }

    // Below the minimum width only the banner is drawn, so nothing else may act.
    if (isTooNarrow) {
      if (key.escape) {
        exit();
        return STOP_KEYS;
      }
      return;
    }

    // Escape: clear query or exit
    if (key.escape) {
      if (editor.getValue()) {
        editor.clear();
        restartList();
      } else {
        exit();
        return STOP_KEYS;
      }
      return;
    }

    if (handleNavigationKey(key) || handleEntryKey(input, key)) return;

    if (editor.apply(input, key)) restartList();
  });

  if (isTooNarrow) {
    return (
      <Box>
        <Text color="yellow">
          Terminal too narrow ({columns} cols). Minimum: {MIN_USABLE_WIDTH}. Press ^C to quit.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns}>
      <SearchBar
        query={query}
        cursor={editor.cursor}
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
          selectedIndex={selectedIndex}
          scrollTop={scrollTop}
          visibleCount={visibleCount}
          width={resultsWidth}
        />
        {showPreview && (
          <>
            <Text>│</Text>
            <PreviewPane
              entry={selectedEntry}
              query={query}
              scrollTop={previewScrollTopFor(selectedEntry?.id ?? null)}
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
        showPreview={showPreview}
      />
    </Box>
  );
}
