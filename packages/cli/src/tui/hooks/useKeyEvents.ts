import { useRef } from 'react';
import { useInput, usePaste } from 'ink';
import type { Key } from 'ink';
import { isEntryActionKey } from '../keys.js';
import {
  NO_PASTE,
  isImmediateKeystroke,
  outputsOf,
  resolveRead,
  type PasteState,
  type ReadEvent,
  type ReadOutput,
} from '../pasteReads.js';

export { PASTE_BURST_MS } from '../pasteReads.js';

/** Returned by a handler to drop the rest of the keys of the current read. */
export const STOP_KEYS = 'stop';

type KeyHandler = (input: string, key: Key) => typeof STOP_KEYS | void;
/** Gets the cleaned text of a paste; never called with an empty string. */
type PasteHandler = (text: string) => void;

/** The stdin read being handled. Ink emits its events synchronously; a microtask ends the read. */
interface ReadState {
  readonly started: boolean;
  /** Every event of the read, handled at once or held. */
  readonly seen: readonly ReadEvent[];
  /** Events held back to the end of the read, because what follows them decides what they mean. */
  readonly held: readonly ReadEvent[];
  readonly actionDispatched: boolean;
  /** A handler quit: nothing later in this read is acted on. */
  readonly stopped: boolean;
}

const NO_READ: ReadState = {
  started: false,
  seen: [],
  held: [],
  actionDispatched: false,
  stopped: false,
};

/**
 * `useInput` that calls `onKey` once per key, in order, however many keys arrived in one stdin
 * read, and `onPaste` once per paste, whether the terminal marked it (bracketed paste, which Ink
 * delivers on its own channel) or sent it as a run of raw bytes.
 *
 * Paste-or-keys is decided per read, not per Ink event (see pasteReads.ts). The first event of a
 * read that is plainly a typed key, or a bracketed paste, is handled at once, inside Ink's update
 * batch, so a keystroke renders as it always did; anything else waits for the microtask that ends
 * the read, when every event of the read is known. Handlers must not rely on React state updated
 * by an earlier key of the same read: that state only renders after the read. A handler that
 * quits returns STOP_KEYS so the keys typed after the quit in the same read are not acted on.
 *
 * Work per read is bounded: only the first entry action (Enter, Ctrl+F, Ctrl+O) of a read is
 * dispatched, later ones are dropped while text and navigation keys still apply in order. A read
 * that carries a paste of any kind fires no entry action at all: the keys that came with it in
 * the same read are text or nothing (resolveRead's boundary rule).
 */
export function useKeyEvents(onKey: KeyHandler, onPaste: PasteHandler): void {
  const read = useRef<ReadState>(NO_READ);
  const paste = useRef<PasteState>(NO_PASTE);

  const emitKey = (input: string, key: Key) => {
    if (isEntryActionKey(input, key)) {
      if (read.current.actionDispatched) return;
      read.current = { ...read.current, actionDispatched: true };
    }
    if (onKey(input, key) === STOP_KEYS) read.current = { ...read.current, stopped: true };
  };

  const emitAll = (outputs: readonly ReadOutput[]) => {
    for (const output of outputs) {
      if (read.current.stopped) return;
      if (output.kind === 'text') onPaste(output.text);
      else emitKey(output.input, output.key);
    }
  };

  // Runs once Ink has emitted every event of the read.
  const endRead = () => {
    const { held, seen, stopped } = read.current;
    if (!stopped) {
      const resolved = resolveRead(paste.current, held, seen, Date.now());
      paste.current = resolved.state;
      emitAll(resolved.outputs);
    }
    read.current = NO_READ;
  };

  const collect = (event: ReadEvent) => {
    const first = !read.current.started;
    if (first) {
      read.current = { ...NO_READ, started: true };
      queueMicrotask(endRead);
    }
    const seen = [...read.current.seen, event];
    if (first && isImmediateKeystroke(paste.current, event, Date.now())) {
      read.current = { ...read.current, seen };
      emitAll(outputsOf(event));
      return;
    }
    read.current = { ...read.current, seen, held: [...read.current.held, event] };
  };

  usePaste((text) => collect({ kind: 'paste', text }));
  useInput((input, key) => collect({ kind: 'key', input, key }));
}
