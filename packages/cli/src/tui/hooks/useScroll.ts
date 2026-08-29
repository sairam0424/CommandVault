import { useReducer, useCallback } from 'react';

export interface ScrollState {
  selectedIndex: number;
  scrollTop: number;
  moveUp: () => void;
  moveDown: () => void;
  reset: () => void;
}

interface State {
  selectedIndex: number;
  scrollTop: number;
}

type Action =
  { type: 'up' } | { type: 'down'; itemCount: number; visibleCount: number } | { type: 'reset' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return { selectedIndex: 0, scrollTop: 0 };
    case 'up': {
      if (state.selectedIndex <= 0) return state;
      const next = state.selectedIndex - 1;
      return { selectedIndex: next, scrollTop: Math.min(state.scrollTop, next) };
    }
    case 'down': {
      if (action.itemCount === 0 || state.selectedIndex >= action.itemCount - 1) return state;
      const next = state.selectedIndex + 1;
      const maxTop = next - action.visibleCount + 1;
      return {
        selectedIndex: next,
        scrollTop: maxTop > state.scrollTop ? maxTop : state.scrollTop,
      };
    }
    default:
      return state;
  }
}

export function useScroll(itemCount: number, visibleCount: number): ScrollState {
  const [state, dispatch] = useReducer(reducer, { selectedIndex: 0, scrollTop: 0 });

  const moveUp = useCallback(() => dispatch({ type: 'up' }), []);
  const moveDown = useCallback(
    () => dispatch({ type: 'down', itemCount, visibleCount }),
    [itemCount, visibleCount],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { ...state, moveUp, moveDown, reset };
}
