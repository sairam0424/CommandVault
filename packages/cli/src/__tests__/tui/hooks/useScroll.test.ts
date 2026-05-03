// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScroll } from '../../../tui/hooks/useScroll.js';

describe('useScroll', () => {
  it('starts at selectedIndex=0, scrollTop=0', () => {
    const { result } = renderHook(() => useScroll(10, 3));
    expect(result.current.selectedIndex).toBe(0);
    expect(result.current.scrollTop).toBe(0);
  });

  it('moveDown increments selectedIndex', () => {
    const { result } = renderHook(() => useScroll(10, 3));
    act(() => result.current.moveDown());
    expect(result.current.selectedIndex).toBe(1);
  });

  it('moveUp at top is no-op (stays 0)', () => {
    const { result } = renderHook(() => useScroll(10, 3));
    act(() => result.current.moveUp());
    expect(result.current.selectedIndex).toBe(0);
    expect(result.current.scrollTop).toBe(0);
  });

  it('moveDown at bottom is no-op (stays itemCount-1)', () => {
    const { result } = renderHook(() => useScroll(3, 5));
    act(() => result.current.moveDown());
    act(() => result.current.moveDown());
    act(() => result.current.moveDown()); // attempt beyond end
    expect(result.current.selectedIndex).toBe(2);
  });

  it('scrollTop advances when selectedIndex leaves visible window', () => {
    // visibleCount=3: visible window is [scrollTop, scrollTop+2]
    // after 3 moveDowns: selectedIndex=3, scrollTop should become 1
    const { result } = renderHook(() => useScroll(10, 3));
    act(() => result.current.moveDown()); // idx=1, top=0
    act(() => result.current.moveDown()); // idx=2, top=0
    act(() => result.current.moveDown()); // idx=3, top=1
    expect(result.current.selectedIndex).toBe(3);
    expect(result.current.scrollTop).toBe(1);
  });

  it('scrollTop retreats on moveUp back past window top', () => {
    const { result } = renderHook(() => useScroll(10, 3));
    // Move down to scrollTop=1
    act(() => result.current.moveDown());
    act(() => result.current.moveDown());
    act(() => result.current.moveDown()); // idx=3, top=1
    // Move back up: idx=2, top still 1; idx=1, top should retreat to 1 (still ok); idx=0, top should be 0
    act(() => result.current.moveUp()); // idx=2, top=1
    act(() => result.current.moveUp()); // idx=1, top=1
    act(() => result.current.moveUp()); // idx=0, top=0
    expect(result.current.selectedIndex).toBe(0);
    expect(result.current.scrollTop).toBe(0);
  });

  it('reset returns both to 0', () => {
    const { result } = renderHook(() => useScroll(10, 3));
    act(() => result.current.moveDown());
    act(() => result.current.moveDown());
    act(() => result.current.moveDown());
    act(() => result.current.reset());
    expect(result.current.selectedIndex).toBe(0);
    expect(result.current.scrollTop).toBe(0);
  });

  it('zero items: moveDown is no-op', () => {
    const { result } = renderHook(() => useScroll(0, 3));
    act(() => result.current.moveDown());
    expect(result.current.selectedIndex).toBe(0);
  });

  it('zero items: moveUp is no-op', () => {
    const { result } = renderHook(() => useScroll(0, 3));
    act(() => result.current.moveUp());
    expect(result.current.selectedIndex).toBe(0);
  });
});
