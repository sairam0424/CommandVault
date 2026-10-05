import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { editQuery } from '../../tui/editQuery.js';

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

const key = (overrides: Partial<Key>): Key => ({ ...NO_KEY, ...overrides });

describe('editQuery', () => {
  it('inserts printable input at the cursor, including the old shortcut letters', () => {
    expect(editQuery({ value: 'ac', cursor: 1 }, 'b', NO_KEY)).toEqual({ value: 'abc', cursor: 2 });
    for (const letter of ['q', 'o', 'f', '[', ']']) {
      expect(editQuery({ value: '', cursor: 0 }, letter, NO_KEY)).toEqual({
        value: letter,
        cursor: 1,
      });
    }
  });

  it('inserts a pasted chunk in one step', () => {
    expect(editQuery({ value: 'ad', cursor: 1 }, 'bc', NO_KEY)).toEqual({
      value: 'abcd',
      cursor: 3,
    });
  });

  it('leaves the state untouched for Ctrl and Meta chords', () => {
    const state = { value: 'ab', cursor: 1 };
    expect(editQuery(state, 'f', key({ ctrl: true }))).toBe(state);
    expect(editQuery(state, 'o', key({ ctrl: true }))).toBe(state);
    expect(editQuery(state, 'o', key({ meta: true }))).toBe(state);
  });

  it('leaves the state untouched for keys the screen owns', () => {
    const state = { value: 'ab', cursor: 1 };
    const screenKeys: Partial<Key>[] = [
      { upArrow: true },
      { downArrow: true },
      { pageUp: true },
      { pageDown: true },
      { tab: true },
      { return: true },
      { escape: true },
    ];
    for (const overrides of screenKeys) {
      expect(editQuery(state, '', key(overrides))).toBe(state);
    }
  });

  it('moves the cursor within the text and never past either end', () => {
    expect(editQuery({ value: 'ab', cursor: 1 }, '', key({ leftArrow: true })).cursor).toBe(0);
    expect(editQuery({ value: 'ab', cursor: 0 }, '', key({ leftArrow: true })).cursor).toBe(0);
    expect(editQuery({ value: 'ab', cursor: 1 }, '', key({ rightArrow: true })).cursor).toBe(2);
    expect(editQuery({ value: 'ab', cursor: 2 }, '', key({ rightArrow: true })).cursor).toBe(2);
    expect(editQuery({ value: 'ab', cursor: 1 }, '', key({ home: true })).cursor).toBe(0);
    expect(editQuery({ value: 'ab', cursor: 1 }, '', key({ end: true })).cursor).toBe(2);
  });

  it('deletes the character before the cursor on backspace and delete', () => {
    expect(editQuery({ value: 'abc', cursor: 2 }, '', key({ backspace: true }))).toEqual({
      value: 'ac',
      cursor: 1,
    });
    expect(editQuery({ value: 'abc', cursor: 3 }, '', key({ delete: true }))).toEqual({
      value: 'ab',
      cursor: 2,
    });
  });

  it('ignores backspace at the start and empty input', () => {
    const state = { value: 'ab', cursor: 0 };
    expect(editQuery(state, '', key({ backspace: true }))).toBe(state);
    expect(editQuery(state, '', NO_KEY)).toBe(state);
  });

  it('does not mutate the state it was given', () => {
    const state = Object.freeze({ value: 'ab', cursor: 1 });
    expect(() => editQuery(state, 'x', NO_KEY)).not.toThrow();
    expect(state).toEqual({ value: 'ab', cursor: 1 });
  });
});
