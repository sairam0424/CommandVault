import { useCallback, useReducer } from 'react';

/** The entry the preview shows, as of the key being handled. */
export interface PreviewTarget {
  readonly id: string | null;
  readonly lineCount: number;
}

export interface PreviewScrollState {
  /** Scroll offset of the preview for this entry; any other entry starts at the top. */
  scrollTopFor: (id: string | null) => number;
  pageUp: (target: PreviewTarget) => void;
  pageDown: (target: PreviewTarget) => void;
  reset: () => void;
}

interface State {
  readonly id: string | null;
  readonly top: number;
}

interface PageAction {
  readonly id: string | null;
  readonly lineCount: number;
  readonly visibleLines: number;
  readonly pageSize: number;
}

type Action = ({ type: 'up' } & PageAction) | ({ type: 'down' } & PageAction) | { type: 'reset' };

const START: State = { id: null, top: 0 };

function topFor(state: State, id: string | null): number {
  return state.id === id ? state.top : 0;
}

/** The furthest the pane can scroll: the last line sits on its last text row. */
function maxTopOf(action: PageAction): number {
  return Math.max(0, action.lineCount - action.visibleLines);
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return START;
    case 'up': {
      // The pane draws an offset past its end at the end, so page up from there.
      const shown = Math.min(topFor(state, action.id), maxTopOf(action));
      return { id: action.id, top: Math.max(0, shown - action.pageSize) };
    }
    case 'down': {
      if (action.visibleLines <= 0) return state;
      const top = Math.min(topFor(state, action.id) + action.pageSize, maxTopOf(action));
      return { id: action.id, top };
    }
    default:
      return state;
  }
}

/**
 * Scroll offset of the preview pane, moved a page at a time. The offset is
 * tied to the entry it was scrolled on, so a different entry (the selection
 * moved, or a new query brought other results) shows from its first line.
 */
export function usePreviewScroll(visibleLines: number, pageSize: number): PreviewScrollState {
  const [state, dispatch] = useReducer(reducer, START);

  const scrollTopFor = useCallback((id: string | null) => topFor(state, id), [state]);
  const pageUp = useCallback(
    (target: PreviewTarget) =>
      dispatch({
        type: 'up',
        id: target.id,
        lineCount: target.lineCount,
        visibleLines,
        pageSize,
      }),
    [visibleLines, pageSize],
  );
  const pageDown = useCallback(
    (target: PreviewTarget) =>
      dispatch({
        type: 'down',
        id: target.id,
        lineCount: target.lineCount,
        visibleLines,
        pageSize,
      }),
    [visibleLines, pageSize],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { scrollTopFor, pageUp, pageDown, reset };
}
