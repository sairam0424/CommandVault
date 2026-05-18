import { useReducer, useCallback } from 'react';

export interface PreviewScrollState {
  scrollTop: number;
  scrollUp: () => void;
  scrollDown: () => void;
  reset: () => void;
}

type Action =
  | { type: 'up' }
  | { type: 'down'; contentLineCount: number; visibleLines: number }
  | { type: 'reset' };

function reducer(state: number, action: Action): number {
  switch (action.type) {
    case 'reset':
      return 0;
    case 'up':
      return Math.max(0, state - 1);
    case 'down': {
      if (action.visibleLines <= 0) return state;
      const maxTop = Math.max(0, action.contentLineCount - action.visibleLines);
      return Math.min(state + 1, maxTop);
    }
    default:
      return state;
  }
}

export function usePreviewScroll(
  contentLineCount: number,
  visibleLines: number,
): PreviewScrollState {
  const [scrollTop, dispatch] = useReducer(reducer, 0);

  const scrollUp = useCallback(() => dispatch({ type: 'up' }), []);
  const scrollDown = useCallback(
    () => dispatch({ type: 'down', contentLineCount, visibleLines }),
    [contentLineCount, visibleLines],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { scrollTop, scrollUp, scrollDown, reset };
}
