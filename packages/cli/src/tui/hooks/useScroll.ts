import { useCallback, useReducer, useRef } from 'react';

export interface ScrollState {
  selectedIndex: number;
  scrollTop: number;
  /**
   * `listLength` is the length of the list the key acts on. Give it when the
   * list changed in the same read and has not rendered yet (text typed before
   * the key); it defaults to the rendered list.
   */
  moveUp: (listLength?: number) => void;
  moveDown: (listLength?: number) => void;
  reset: () => void;
  /** The selection as of the last key handled, even before it has rendered. */
  getSelectedIndex: (listLength?: number) => number;
}

interface View {
  readonly selectedIndex: number;
  readonly scrollTop: number;
}

const TOP: View = { selectedIndex: 0, scrollTop: 0 };

/**
 * Pulls a stored position back inside the list and the window. The list can
 * shrink (a query returns fewer rows) and the window can shrink (the terminal
 * is resized) after the position was stored; without this the selection ends
 * up past the last row or scrolled off screen.
 */
function fit(view: View, itemCount: number, visibleCount: number): View {
  if (itemCount === 0) return TOP;
  const windowSize = Math.max(1, visibleCount);
  const selectedIndex = Math.min(Math.max(0, view.selectedIndex), itemCount - 1);
  let scrollTop = Math.min(view.scrollTop, Math.max(0, itemCount - windowSize));
  if (selectedIndex < scrollTop) scrollTop = selectedIndex;
  if (selectedIndex >= scrollTop + windowSize) scrollTop = selectedIndex - windowSize + 1;
  return { selectedIndex, scrollTop };
}

/**
 * Selection and window position of the results list. The position lives in a
 * ref so several keys delivered in one stdin read each start from the result
 * of the one before, not from the last rendered position.
 */
export function useScroll(itemCount: number, visibleCount: number): ScrollState {
  const position = useRef<View>(TOP);
  // Written during render on purpose: every key handler must see the list and
  // window size of the latest render, and neither changes within one read.
  const size = useRef({ itemCount, visibleCount });
  size.current = { itemCount, visibleCount };
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const current = useCallback(
    (listLength: number = size.current.itemCount) =>
      fit(position.current, listLength, size.current.visibleCount),
    [],
  );
  const commit = useCallback(
    (selectedIndex: number, listLength: number = size.current.itemCount) => {
      const before = current(listLength);
      const next = fit(
        { selectedIndex, scrollTop: before.scrollTop },
        listLength,
        size.current.visibleCount,
      );
      if (next.selectedIndex === before.selectedIndex && next.scrollTop === before.scrollTop) {
        return;
      }
      position.current = next;
      rerender();
    },
    [current],
  );

  const moveUp = useCallback(
    (listLength?: number) => commit(current(listLength).selectedIndex - 1, listLength),
    [commit, current],
  );
  const moveDown = useCallback(
    (listLength?: number) => commit(current(listLength).selectedIndex + 1, listLength),
    [commit, current],
  );
  const reset = useCallback(() => {
    position.current = TOP;
    rerender();
  }, []);
  const getSelectedIndex = useCallback(
    (listLength?: number) => current(listLength).selectedIndex,
    [current],
  );

  // Keep the fitted position, so a list that shrank and grows again does not
  // jump back to a selection the user no longer sees.
  const view = fit(position.current, itemCount, visibleCount);
  position.current = view;
  return { ...view, moveUp, moveDown, reset, getSelectedIndex };
}
