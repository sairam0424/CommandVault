import { useInput } from 'ink';
import type { Key } from 'ink';
import { decodeInput } from '../keys.js';

/** Returned by a handler to drop the rest of the keys of the current read. */
export const STOP_KEYS = 'stop';

type KeyHandler = (input: string, key: Key) => typeof STOP_KEYS | void;

/**
 * `useInput` that calls the handler once per key, in order, however many keys
 * arrived in one stdin read. Handlers must not rely on React state updated by
 * an earlier key of the same read: that state only renders after the read.
 * A handler that quits returns STOP_KEYS so the keys typed after the quit in
 * the same read are not acted on.
 */
export function useKeyEvents(handler: KeyHandler): void {
  useInput((input, key) => {
    for (const event of decodeInput(input, key)) {
      if (handler(event.input, event.key) === STOP_KEYS) return;
    }
  });
}
