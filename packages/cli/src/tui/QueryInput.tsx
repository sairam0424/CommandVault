import React from 'react';
import { Text } from 'ink';
import { clamp } from './editQuery.js';

interface Props {
  readonly value: string;
  readonly cursor: number;
  readonly placeholder: string;
}

function Placeholder({ text }: { readonly text: string }) {
  return (
    <>
      <Text inverse>{text.charAt(0) || ' '}</Text>
      <Text dimColor>{text.slice(1)}</Text>
    </>
  );
}

function Editable({ value, cursor }: { readonly value: string; readonly cursor: number }) {
  const atEnd = cursor >= value.length;
  return (
    <>
      <Text>{value.slice(0, cursor)}</Text>
      <Text inverse>{atEnd ? ' ' : value.charAt(cursor)}</Text>
      <Text>{atEnd ? '' : value.slice(cursor + 1)}</Text>
    </>
  );
}

/** Draws the search box. Keys are handled by `App`, in order, through `useQueryEditor`. */
export function QueryInput({ value, cursor, placeholder }: Props) {
  return (
    <Text>
      {value.length === 0 ? (
        <Placeholder text={placeholder} />
      ) : (
        <Editable value={value} cursor={clamp(cursor, value.length)} />
      )}
    </Text>
  );
}
