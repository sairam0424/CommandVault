import React from 'react';
import { Text } from 'ink';
import { clamp } from './editQuery.js';
import { queryWindow } from './queryWindow.js';

interface Props {
  readonly value: string;
  readonly cursor: number;
  readonly placeholder: string;
  /** Columns the query may use; what does not fit is scrolled out of view, never wrapped. */
  readonly capacity: number;
}

function Placeholder({ text }: { readonly text: string }) {
  return (
    <>
      <Text inverse>{text.charAt(0) || ' '}</Text>
      <Text dimColor>{text.slice(1)}</Text>
    </>
  );
}

function Editable({
  value,
  cursor,
  capacity,
}: {
  readonly value: string;
  readonly cursor: number;
  readonly capacity: number;
}) {
  const { before, at, after } = queryWindow(value, cursor, capacity);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </>
  );
}

/** Draws the search box. Keys are handled by `App`, in order, through `useQueryEditor`. */
export function QueryInput({ value, cursor, placeholder, capacity }: Props) {
  // One row whatever the query holds: the frame arithmetic in App counts the bar as three rows.
  return (
    <Text wrap="truncate-end">
      {value.length === 0 ? (
        <Placeholder text={placeholder} />
      ) : (
        <Editable value={value} cursor={clamp(cursor, value.length)} capacity={capacity} />
      )}
    </Text>
  );
}
