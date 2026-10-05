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
    act(() => result.current.moveDown()); // idx=1
    act(() => result.current.moveDown()); // idx=2
    act(() => result.current.moveDown()); // idx=3, top=1
    expect(result.current.scrollTop).toBe(1); // intermediate: verify top advanced
    act(() => result.current.moveUp()); // idx=2, top=1 (2 still in [1,2,3])
    expect(result.current.scrollTop).toBe(1); // intermediate: not yet retreated
    act(() => result.current.moveUp()); // idx=1, top=1 (1 still in [1,2,3])
    act(() => result.current.moveUp()); // idx=0, top=0 (0 not in [1,2,3] → retreat)
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

  describe('when the list or the window changes under the selection', () => {
    it('keeps the selection on the last row when the list shrinks below it', () => {
      const { result, rerender } = renderHook(({ count }) => useScroll(count, 3), {
        initialProps: { count: 10 },
      });
      for (let i = 0; i < 7; i += 1) act(() => result.current.moveDown());
      expect(result.current.selectedIndex).toBe(7);

      rerender({ count: 3 });

      expect(result.current.selectedIndex).toBe(2);
      expect(result.current.scrollTop).toBe(0);
    });

    it('scrolls the window to keep the selection visible when the window shrinks', () => {
      const { result, rerender } = renderHook(({ visible }) => useScroll(12, visible), {
        initialProps: { visible: 12 },
      });
      for (let i = 0; i < 11; i += 1) act(() => result.current.moveDown());

      rerender({ visible: 4 });

      expect(result.current.selectedIndex).toBe(11);
      expect(result.current.scrollTop).toBe(8);
    });

    it('returns to the top of an emptied list and moves normally once it refills', () => {
      const { result, rerender } = renderHook(({ count }) => useScroll(count, 3), {
        initialProps: { count: 5 },
      });
      act(() => result.current.moveDown());

      rerender({ count: 0 });
      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.scrollTop).toBe(0);

      rerender({ count: 5 });
      act(() => result.current.moveDown());
      expect(result.current.selectedIndex).toBe(1);
    });
  });

  describe('several moves before the next render', () => {
    it('applies each move to the result of the previous one', () => {
      const { result } = renderHook(() => useScroll(10, 3));
      act(() => {
        result.current.moveDown();
        result.current.moveDown();
        result.current.moveDown();
        result.current.moveUp();
      });
      expect(result.current.selectedIndex).toBe(2);
    });

    it('reports the selection as it is right now, before any render', () => {
      const { result } = renderHook(() => useScroll(10, 3));
      act(() => {
        result.current.moveDown();
        result.current.moveDown();
        expect(result.current.getSelectedIndex()).toBe(2);
      });
    });
  });

  describe('a list length given for a list that has not rendered yet', () => {
    it('bounds moveDown by the given length, not the rendered one', () => {
      const { result } = renderHook(() => useScroll(3, 3));
      act(() => {
        result.current.moveDown(1);
        result.current.moveDown(1);
      });
      expect(result.current.getSelectedIndex(1)).toBe(0);
    });

    it('lets moveDown go past the rendered length when the new list is longer', () => {
      const { result } = renderHook(() => useScroll(1, 3));
      act(() => {
        result.current.moveDown(3);
        result.current.moveDown(3);
        expect(result.current.getSelectedIndex(3)).toBe(2);
      });
    });

    it('fits the reported selection to the given length', () => {
      const { result } = renderHook(() => useScroll(5, 3));
      act(() => {
        result.current.moveDown();
        result.current.moveDown();
        result.current.moveDown();
        expect(result.current.getSelectedIndex(2)).toBe(1);
      });
    });
  });
});
