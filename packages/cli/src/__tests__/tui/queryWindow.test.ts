import { describe, it, expect } from 'vitest';
import { queryWindow } from '../../tui/queryWindow.js';
import { cellWidth } from '../../tui/text.js';

const columnsOf = (w: { before: string; at: string; after: string }): number =>
  [...`${w.before}${w.at}${w.after}`].reduce((sum, c) => sum + cellWidth(c), 0);

describe('queryWindow', () => {
  it('shows a query that fits whole, with the cursor cell after it', () => {
    expect(queryWindow('abc', 3, 10)).toEqual({ before: 'abc', at: ' ', after: '' });
  });

  it('puts the cursor on the character it is over', () => {
    expect(queryWindow('abc', 1, 10)).toEqual({ before: 'a', at: 'b', after: 'c' });
  });

  it('shows the tail of a long query when the cursor is at the end', () => {
    const w = queryWindow('abcdefghij', 10, 5);
    expect(w).toEqual({ before: 'ghij', at: ' ', after: '' });
    expect(columnsOf(w)).toBe(5);
  });

  it('starts at the cursor when it is left of the tail', () => {
    const w = queryWindow('abcdefghij', 0, 5);
    expect(w).toEqual({ before: '', at: 'a', after: 'bcde' });
    expect(columnsOf(w)).toBe(5);
  });

  it('keeps the cursor in view in the middle of a long query', () => {
    const w = queryWindow('abcdefghij', 2, 5);
    expect(w.at).toBe('c');
    expect(columnsOf(w)).toBeLessThanOrEqual(5);
  });

  it('counts wide characters as two columns', () => {
    const w = queryWindow('部部部部部部', 6, 7);
    expect(w).toEqual({ before: '部部部', at: ' ', after: '' });
    expect(columnsOf(w)).toBe(7);
  });

  it('counts emoji that Ink draws two columns wide as two', () => {
    for (const char of ['✅', '⭐', '⚡', '🚀', '🧠']) expect(cellWidth(char)).toBe(2);
    for (const char of ['a', '★', '→', 'é']) expect(cellWidth(char)).toBe(1);
  });

  it('never splits an emoji', () => {
    const w = queryWindow('🚀🚀🚀🚀', 8, 5);
    expect(w.before).toBe('🚀🚀');
  });

  it('still shows the cursor in a one-column box', () => {
    expect(queryWindow('abc', 3, 1)).toEqual({ before: '', at: ' ', after: '' });
    expect(queryWindow('abc', 0, 0).at).toBe('a');
  });

  it('shows the empty query as just the cursor cell', () => {
    expect(queryWindow('', 0, 10)).toEqual({ before: '', at: ' ', after: '' });
  });
});
