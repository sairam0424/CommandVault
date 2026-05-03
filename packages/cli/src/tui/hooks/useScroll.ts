import { useState, useCallback } from 'react';

export interface ScrollState {
  selectedIndex: number;
  scrollTop: number;
  moveUp: () => void;
  moveDown: () => void;
  reset: () => void;
}

export function useScroll(itemCount: number, visibleCount: number): ScrollState {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => {
      if (prev <= 0) return prev;
      const next = prev - 1;
      setScrollTop((top) => Math.min(top, next));
      return next;
    });
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => {
      if (itemCount === 0 || prev >= itemCount - 1) return prev;
      const next = prev + 1;
      setScrollTop((top) => {
        const maxTop = next - visibleCount + 1;
        return maxTop > top ? maxTop : top;
      });
      return next;
    });
  }, [itemCount, visibleCount]);

  const reset = useCallback(() => {
    setSelectedIndex(0);
    setScrollTop(0);
  }, []);

  return { selectedIndex, scrollTop, moveUp, moveDown, reset };
}
