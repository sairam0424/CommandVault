import { useCallback, useRef, useState } from 'react';
import type { Key } from 'ink';
import { EMPTY_EDIT, editQuery, type EditState } from '../editQuery.js';

export interface QueryEditor {
  readonly value: string;
  readonly cursor: number;
  /** The text as of the last key handled, even before it has rendered. */
  readonly getValue: () => string;
  /** Feed one key; returns true when it changed the text (not just the cursor). */
  readonly apply: (input: string, key: Key) => boolean;
  readonly clear: () => void;
}

/**
 * The search box text and cursor. The latest state lives in a ref as well as
 * in React state so the next key of a batched read edits the result of the
 * previous one instead of the last rendered text.
 */
export function useQueryEditor(): QueryEditor {
  const latest = useRef<EditState>(EMPTY_EDIT);
  const [state, setState] = useState<EditState>(EMPTY_EDIT);

  const commit = useCallback((next: EditState) => {
    latest.current = next;
    setState(next);
  }, []);

  const apply = useCallback(
    (input: string, key: Key) => {
      const previous = latest.current;
      const next = editQuery(previous, input, key);
      if (next.value === previous.value && next.cursor === previous.cursor) return false;
      commit(next);
      return next.value !== previous.value;
    },
    [commit],
  );

  const clear = useCallback(() => commit(EMPTY_EDIT), [commit]);
  const getValue = useCallback(() => latest.current.value, []);

  return { value: state.value, cursor: state.cursor, getValue, apply, clear };
}
