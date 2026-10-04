import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Key } from 'ink';

interface EditState {
  readonly value: string;
  readonly cursor: number;
}

interface Props {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
}

// Keys that belong to the surrounding screen (navigation, submit, dismiss),
// never to the text being edited.
function isScreenKey(key: Key): boolean {
  return (
    key.upArrow ||
    key.downArrow ||
    key.pageUp ||
    key.pageDown ||
    key.tab ||
    key.return ||
    key.escape
  );
}

function clamp(position: number, length: number): number {
  return Math.max(0, Math.min(position, length));
}

/**
 * Pure edit step for the search box. Ctrl/Meta chords are ignored here on
 * purpose: ink reports Ctrl+F as input "f", so a generic text input would type
 * the letter and move the cursor every time an action shortcut is pressed.
 */
export function editQuery(state: EditState, input: string, key: Key): EditState {
  const { value, cursor } = state;
  if (key.ctrl || key.meta || isScreenKey(key)) return state;

  if (key.leftArrow) return { value, cursor: clamp(cursor - 1, value.length) };
  if (key.rightArrow) return { value, cursor: clamp(cursor + 1, value.length) };
  if (key.home) return { value, cursor: 0 };
  if (key.end) return { value, cursor: value.length };

  if (key.backspace || key.delete) {
    if (cursor === 0) return state;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }

  if (!input) return state;
  return {
    value: value.slice(0, cursor) + input + value.slice(cursor),
    cursor: cursor + input.length,
  };
}

function Placeholder({ text }: { readonly text: string }) {
  return (
    <>
      <Text inverse>{text.charAt(0) || ' '}</Text>
      <Text dimColor>{text.slice(1)}</Text>
    </>
  );
}

function Editable({ value, cursor }: EditState) {
  const atEnd = cursor >= value.length;
  return (
    <>
      <Text>{value.slice(0, cursor)}</Text>
      <Text inverse>{atEnd ? ' ' : value.charAt(cursor)}</Text>
      <Text>{atEnd ? '' : value.slice(cursor + 1)}</Text>
    </>
  );
}

export function QueryInput({ value, onChange, placeholder }: Props) {
  const [storedCursor, setStoredCursor] = useState(value.length);
  // The query can be cleared from outside (Esc), which leaves the stored
  // cursor past the end until the next edit.
  const cursor = clamp(storedCursor, value.length);

  useInput((input, key) => {
    const next = editQuery({ value, cursor }, input, key);
    if (next.cursor !== storedCursor) setStoredCursor(next.cursor);
    if (next.value !== value) onChange(next.value);
  });

  return (
    <Text>
      {value.length === 0 ? (
        <Placeholder text={placeholder} />
      ) : (
        <Editable value={value} cursor={cursor} />
      )}
    </Text>
  );
}
