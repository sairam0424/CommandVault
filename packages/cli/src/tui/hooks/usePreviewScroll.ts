import { useState, useCallback } from 'react';

export interface PreviewScrollState {
  scrollTop: number;
  scrollUp: () => void;
  scrollDown: () => void;
  reset: () => void;
}

export function usePreviewScroll(contentLineCount: number, visibleLines: number): PreviewScrollState {
  const [scrollTop, setScrollTop] = useState(0);

  const scrollUp = useCallback(() => {
    setScrollTop((prev) => Math.max(0, prev - 1));
  }, []);

  const scrollDown = useCallback(() => {
    setScrollTop((prev) => {
      const maxTop = Math.max(0, contentLineCount - visibleLines);
      return Math.min(prev + 1, maxTop);
    });
  }, [contentLineCount, visibleLines]);

  const reset = useCallback(() => setScrollTop(0), []);

  return { scrollTop, scrollUp, scrollDown, reset };
}
