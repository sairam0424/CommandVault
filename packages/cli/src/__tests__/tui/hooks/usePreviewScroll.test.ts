import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewScroll } from '../../../tui/hooks/usePreviewScroll.js';

const ENTRY = { id: 'alpha', lineCount: 20 };

describe('usePreviewScroll', () => {
  it('starts at scrollTop=0', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  it('pageDown moves by one page', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    act(() => result.current.pageDown(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(3);
  });

  it('pageUp at top is no-op', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    act(() => result.current.pageUp(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  it('pageDown clamps at max(0, lineCount - visibleLines)', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    const short = { id: 'alpha', lineCount: 8 };
    // maxTop = 8 - 5 = 3
    act(() => result.current.pageDown(short));
    act(() => result.current.pageDown(short)); // would be 6, clamps at 3
    expect(result.current.scrollTopFor('alpha')).toBe(3);
  });

  it('pageDown is no-op when content fits in view', () => {
    const { result } = renderHook(() => usePreviewScroll(10, 10));
    act(() => result.current.pageDown({ id: 'alpha', lineCount: 3 }));
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  it('pageDown is no-op when visibleLines=0', () => {
    const { result } = renderHook(() => usePreviewScroll(0, 1));
    act(() => result.current.pageDown(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  it('pageUp goes back one page and clamps at the top', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    act(() => result.current.pageDown(ENTRY));
    act(() => result.current.pageDown(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(6);
    act(() => result.current.pageUp(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(3);
    act(() => result.current.pageUp(ENTRY));
    act(() => result.current.pageUp(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  it('pages up from where the pane is drawn when the stored offset lies past its end', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    const long = { id: 'alpha', lineCount: 30 };
    act(() => {
      for (let press = 0; press < 20; press += 1) result.current.pageDown(long);
    });
    expect(result.current.scrollTopFor('alpha')).toBe(25);
    // The excerpt shrank (the window got smaller), so the pane now ends at 10.
    const shrunk = { id: 'alpha', lineCount: 15 };
    act(() => result.current.pageUp(shrunk));
    expect(result.current.scrollTopFor('alpha')).toBe(7);
  });

  it('applies several page keys delivered before the next render', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 4));
    const long = { id: 'alpha', lineCount: 30 };
    act(() => {
      result.current.pageDown(long);
      result.current.pageDown(long);
      result.current.pageUp(long);
    });
    expect(result.current.scrollTopFor('alpha')).toBe(4);
  });

  it('shows any other entry from its first line', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    act(() => result.current.pageDown(ENTRY));
    expect(result.current.scrollTopFor('alpha')).toBe(3);
    expect(result.current.scrollTopFor('beta')).toBe(0);
    expect(result.current.scrollTopFor(null)).toBe(0);
  });

  it('starts a page key on a different entry from its first line', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    act(() => {
      result.current.pageDown(ENTRY);
      result.current.pageDown({ id: 'beta', lineCount: 20 });
    });
    expect(result.current.scrollTopFor('beta')).toBe(3);
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  it('reset returns scrollTop to 0', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    act(() => result.current.pageDown(ENTRY));
    act(() => result.current.pageDown(ENTRY));
    act(() => result.current.reset());
    expect(result.current.scrollTopFor('alpha')).toBe(0);
  });

  describe('an entry that starts below its first line (the first match of the query)', () => {
    it('shows the entry from that line until the user pages', () => {
      const { result } = renderHook(() => usePreviewScroll(5, 3));
      expect(result.current.scrollTopFor('alpha', 12)).toBe(12);
    });

    it('pages from that line, not from the top', () => {
      const { result } = renderHook(() => usePreviewScroll(5, 3));
      const target = { ...ENTRY, lineCount: 40, initialTop: 12 };
      act(() => result.current.pageDown(target));
      expect(result.current.scrollTopFor('alpha', 12)).toBe(15);
      act(() => result.current.pageUp(target));
      act(() => result.current.pageUp(target));
      expect(result.current.scrollTopFor('alpha', 12)).toBe(9);
    });

    it('returns to that line on reset and gives another entry its own line', () => {
      const { result } = renderHook(() => usePreviewScroll(5, 3));
      const target = { ...ENTRY, lineCount: 40, initialTop: 12 };
      act(() => result.current.pageDown(target));
      expect(result.current.scrollTopFor('beta', 4)).toBe(4);
      act(() => result.current.reset());
      expect(result.current.scrollTopFor('alpha', 12)).toBe(12);
    });
  });
});
