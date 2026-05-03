// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewScroll } from '../../../tui/hooks/usePreviewScroll.js';

describe('usePreviewScroll', () => {
  it('starts at scrollTop=0', () => {
    const { result } = renderHook(() => usePreviewScroll(20, 5));
    expect(result.current.scrollTop).toBe(0);
  });

  it('scrollDown increments scrollTop', () => {
    const { result } = renderHook(() => usePreviewScroll(20, 5));
    act(() => result.current.scrollDown());
    expect(result.current.scrollTop).toBe(1);
  });

  it('scrollUp at top is no-op', () => {
    const { result } = renderHook(() => usePreviewScroll(20, 5));
    act(() => result.current.scrollUp());
    expect(result.current.scrollTop).toBe(0);
  });

  it('scrollDown clamps at max(0, contentLineCount - visibleLines)', () => {
    const { result } = renderHook(() => usePreviewScroll(5, 3));
    // maxTop = 5 - 3 = 2
    act(() => result.current.scrollDown());
    act(() => result.current.scrollDown());
    act(() => result.current.scrollDown()); // should clamp at 2
    expect(result.current.scrollTop).toBe(2);
  });

  it('scrollDown is no-op when content fits in view', () => {
    const { result } = renderHook(() => usePreviewScroll(3, 10));
    // maxTop = max(0, 3-10) = 0 → scrollDown is no-op
    act(() => result.current.scrollDown());
    expect(result.current.scrollTop).toBe(0);
  });

  it('scrollDown is no-op when visibleLines=0', () => {
    const { result } = renderHook(() => usePreviewScroll(20, 0));
    act(() => result.current.scrollDown());
    expect(result.current.scrollTop).toBe(0);
  });

  it('scrollUp decrements after scrollDown', () => {
    const { result } = renderHook(() => usePreviewScroll(20, 5));
    act(() => result.current.scrollDown());
    act(() => result.current.scrollDown());
    act(() => result.current.scrollUp());
    expect(result.current.scrollTop).toBe(1);
  });

  it('reset returns scrollTop to 0', () => {
    const { result } = renderHook(() => usePreviewScroll(20, 5));
    act(() => result.current.scrollDown());
    act(() => result.current.scrollDown());
    act(() => result.current.reset());
    expect(result.current.scrollTop).toBe(0);
  });
});
