import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { NO_KEY } from '../../tui/keys.js';
import {
  NO_PASTE,
  PASTE_BURST_MS,
  PASTE_OPEN_IDLE_MS,
  isImmediateKeystroke,
  outputsOf,
  resolveRead,
  type PasteState,
  type ReadEvent,
  type ReadOutput,
} from '../../tui/pasteReads.js';

const NOW = 1_700_000_000_000;
const ENTER_KEY: Key = { ...NO_KEY, return: true };
const CTRL_KEY: Key = { ...NO_KEY, ctrl: true };
const ESCAPE_KEY: Key = { ...NO_KEY, escape: true };

/** An unresolved run of bytes, as Ink hands it to the key handler. */
const typed = (input: string): ReadEvent => ({ kind: 'key', input, key: NO_KEY });
const enter: ReadEvent = { kind: 'key', input: '', key: ENTER_KEY };
const ctrl = (letter: string): ReadEvent => ({ kind: 'key', input: letter, key: CTRL_KEY });
const bracketed = (text: string): ReadEvent => ({ kind: 'paste', text });

const text = (value: string): ReadOutput => ({ kind: 'text', text: value });
const key = (input: string, k: Key = NO_KEY): ReadOutput => ({ kind: 'key', input, key: k });

/** A whole read: nothing was handled early, so `held` and `seen` are the same events. */
const read = (state: PasteState, events: readonly ReadEvent[], now = NOW) =>
  resolveRead(state, events, events, now);

const inBurst: PasteState = { ...NO_PASTE, burstUntil: NOW + PASTE_BURST_MS };
const open: PasteState = {
  ...NO_PASTE,
  burstUntil: NOW + PASTE_BURST_MS,
  openUntil: NOW + PASTE_OPEN_IDLE_MS,
};

describe('resolveRead with keys', () => {
  it('passes a typed letter through as a key and arms nothing', () => {
    const { state, outputs } = read(NO_PASTE, [typed('a')]);

    expect(outputs).toEqual([key('a')]);
    expect(state).toEqual(NO_PASTE);
  });

  it('splits a run holding control bytes into its text and its keys', () => {
    const { outputs } = read(NO_PASTE, [typed('ab\x06')]);

    expect(outputs).toEqual([key('ab'), key('f', CTRL_KEY)]);
  });

  it('drops the tail of a key sequence Ink did not resolve', () => {
    const { outputs } = read(NO_PASTE, [typed('[I')]);

    expect(outputs).toEqual([]);
  });

  it('takes two line breaks in one short read as a raw paste and opens the burst window', () => {
    const { state, outputs } = read(NO_PASTE, [typed('a\rb\r')]);

    expect(outputs).toEqual([text('a b')]);
    expect(state.burstUntil).toBe(NOW + PASTE_BURST_MS);
    expect(state.openUntil).toBe(0);
  });

  it('judges the unresolved bytes of a read together when Ink cut it at escape sequences', () => {
    const { outputs } = read(NO_PASTE, [
      typed('demo\n'),
      typed('[33m'),
      typed('x'),
      typed('[0m'),
      typed('\nb'),
    ]);

    expect(outputs).toEqual([text('demo x b')]);
  });

  // A copied terminal log, or hostile clipboard text, can carry the end marker of a bracketed
  // paste; in a raw paste it is an escape sequence like any other, and never closes anything.
  it('drops a literal end marker inside a raw paste and keeps what follows it as text', () => {
    const { state, outputs } = read(NO_PASTE, [typed('demo\n'), typed('[201~'), typed('xyz\n')]);

    expect(outputs).toEqual([text('demo xyz')]);
    expect(state.burstUntil).toBe(NOW + PASTE_BURST_MS);
    expect(state.openUntil).toBe(0);
  });
});

describe('resolveRead with a bracketed paste Ink delivered whole', () => {
  it('inserts the paste trimmed and flattened, and leaves every window shut', () => {
    const { state, outputs } = read(NO_PASTE, [bracketed('  a\n\tb  \n')]);

    expect(outputs).toEqual([text('a b')]);
    expect(state).toEqual(NO_PASTE);
  });

  it('emits nothing for a paste of nothing but whitespace', () => {
    const { outputs } = read(NO_PASTE, [bracketed(' \n\t\r\n ')]);

    expect(outputs).toEqual([]);
  });

  it('drops escape sequences inside the paste whole', () => {
    const { outputs } = read(NO_PASTE, [bracketed('\x1b[31mred\x1b[0m \x1b]0;t\x07x')]);

    expect(outputs).toEqual([text('red x')]);
  });

  // Only a script puts keys in the same stdin read as a paste: the boundary rule makes them text
  // where printable and nothing otherwise, so none of them acts on an entry.
  it('turns the keys that came with the paste into text or nothing, acting on none', () => {
    const { state, outputs } = read(NO_PASTE, [enter, bracketed('demo'), ctrl('f'), typed('x')]);

    expect(outputs).toEqual([text('demox')]);
    expect(state).toEqual(NO_PASTE);
  });

  // The hook inserts a paste that heads a read at once, so only the keys after it are held, and
  // the paste is among the events seen alone. No window opens: a whole paste has no pieces.
  it('drops the resolved keys after a paste the hook already inserted, and opens no window', () => {
    const seen = [bracketed('alpha'), enter, ctrl('f')];
    const { state, outputs } = resolveRead(NO_PASTE, seen.slice(1), seen, NOW);

    expect(outputs).toEqual([]);
    expect(state).toEqual(NO_PASTE);
  });

  it('types the printable keys after a paste the hook already inserted', () => {
    const seen = [bracketed('alpha'), typed('bc'), enter];
    const { outputs } = resolveRead(NO_PASTE, seen.slice(1), seen, NOW);

    expect(outputs).toEqual([text('bc')]);
  });
});

describe('resolveRead inside the raw burst window', () => {
  it('takes a short unresolved read as the next piece of the paste', () => {
    const { state, outputs } = read(inBurst, [typed('x')], NOW + 10);

    expect(outputs).toEqual([text('x')]);
    expect(state.burstUntil).toBe(NOW + 10 + PASTE_BURST_MS);
  });

  it('takes the same read as keys once the window has closed', () => {
    const { outputs } = read(inBurst, [typed('x'), enter], NOW + PASTE_BURST_MS);

    expect(outputs).toEqual([key('x'), key('', ENTER_KEY)]);
  });

  it('takes a lone Enter as the line break of the paste and remembers the separator', () => {
    const first = read(inBurst, [enter], NOW + 10);
    const second = read(first.state, [typed('b')], NOW + 20);

    expect(first.outputs).toEqual([]);
    expect(first.state.separatorPending).toBe(true);
    expect(second.outputs).toEqual([text(' b')]);
  });

  it('keeps a key Ink resolved, other than Enter and Tab, as a key', () => {
    const { outputs } = read(inBurst, [ctrl('c')], NOW + 10);

    expect(outputs).toEqual([key('c', CTRL_KEY)]);
  });
});

describe('resolveRead with a start marker Ink flushed in pieces', () => {
  const pieceHeld: PasteState = { ...NO_PASTE, markerPiece: '[20' };

  it('holds a flushed piece of the marker and emits nothing', () => {
    const { state, outputs } = read(NO_PASTE, [typed('[20')]);

    expect(outputs).toEqual([]);
    expect(state.markerPiece).toBe('[20');
  });

  it('strips the rest of the marker off the next read, inserts the body and opens the paste', () => {
    const { state, outputs } = read(pieceHeld, [typed('0~alpha\n')]);

    expect(outputs).toEqual([text('alpha')]);
    expect(state.markerPiece).toBe('');
    expect(state.openUntil).toBe(NOW + PASTE_OPEN_IDLE_MS);
  });

  it('keeps a body piece that comes after the burst window as text, Enter included', () => {
    const late = NOW + PASTE_BURST_MS + 1;
    const { state, outputs } = read(
      { ...open, separatorPending: true },
      [typed('beta'), enter],
      late,
    );

    expect(outputs).toEqual([text(' beta')]);
    expect(state.openUntil).toBe(late + PASTE_OPEN_IDLE_MS);
  });

  it('holds the first event of a read inside the open paste instead of handling it early', () => {
    expect(isImmediateKeystroke(open, typed('b'), NOW + PASTE_BURST_MS + 1)).toBe(false);
  });

  // What follows the end marker in the same read came with pasted bytes: text, never a key.
  it('closes the paste at its end marker and types the keys after it, acting on none', () => {
    const events = [typed('gamma'), typed('[201~'), typed('x'), enter];
    const { state, outputs } = read(open, events, NOW + 1000);

    expect(outputs).toEqual([text('gammax')]);
    expect(state).toEqual(NO_PASTE);
  });

  it('closes a paste whose end marker never comes once the idle ceiling has passed', () => {
    const { outputs } = read(open, [typed('x'), enter], NOW + PASTE_OPEN_IDLE_MS);

    expect(outputs).toEqual([key('x'), key('', ENTER_KEY)]);
  });

  // Keys pressed inside the open paste are swallowed, as its body would be; pressing them must
  // not keep the paste open, or an Enter once a second would be swallowed for good.
  it('does not stretch the idle ceiling for a read of nothing but keys', () => {
    const second = 1000;
    const presses = [1, 2, 3, 4];
    const mashed = presses.reduce((state, i) => {
      const pressed = read(state, [enter], NOW + i * second);
      expect(pressed.outputs).toEqual([]);
      return pressed.state;
    }, open);

    expect(mashed.openUntil).toBe(NOW + PASTE_OPEN_IDLE_MS);
    const { outputs } = read(mashed, [enter], NOW + PASTE_OPEN_IDLE_MS);
    expect(outputs).toEqual([key('', ENTER_KEY)]);
  });

  it('types a held piece that no marker follows, ahead of the key that came after it', () => {
    const { state, outputs } = read(pieceHeld, [typed('x')]);

    expect(outputs).toEqual([key('[20'), key('x')]);
    expect(state.markerPiece).toBe('');
  });

  it('remembers a typed bracket without holding it, and completes the marker after it', () => {
    const first = read(NO_PASTE, [typed('[')]);
    const second = read(first.state, [typed('200~alpha\n')]);

    expect(first.outputs).toEqual([key('[')]);
    expect(first.state.markerPiece).toBe('[');
    expect(second.outputs).toEqual([text('alpha')]);
    expect(second.state.openUntil).toBe(NOW + PASTE_OPEN_IDLE_MS);
  });

  it('takes a whole marker heading a read as the body when Ink flushed the ESC alone', () => {
    const escape = read(NO_PASTE, [{ kind: 'key', input: '', key: ESCAPE_KEY }]);
    const body = read(escape.state, [typed('[200~alpha\n'), typed('[201~')]);

    expect(escape.outputs).toEqual([key('', ESCAPE_KEY)]);
    expect(body.outputs).toEqual([text('alpha')]);
    expect(body.state).toEqual(NO_PASTE);
  });
});

describe('isImmediateKeystroke', () => {
  it('handles a plain keystroke and a whole bracketed paste at once', () => {
    expect(isImmediateKeystroke(NO_PASTE, typed('a'), NOW)).toBe(true);
    expect(isImmediateKeystroke(NO_PASTE, enter, NOW)).toBe(true);
    expect(isImmediateKeystroke(NO_PASTE, bracketed('x\ny'), NOW)).toBe(true);
  });

  it('holds a run with a control byte, a long run and an escape tail', () => {
    expect(isImmediateKeystroke(NO_PASTE, typed('a\x06'), NOW)).toBe(false);
    expect(isImmediateKeystroke(NO_PASTE, typed('a'.repeat(65)), NOW)).toBe(false);
    expect(isImmediateKeystroke(NO_PASTE, typed('[I'), NOW)).toBe(false);
  });

  it('holds a piece of a start marker, a read heading with one, and anything after a held piece', () => {
    expect(isImmediateKeystroke(NO_PASTE, typed('[2'), NOW)).toBe(false);
    expect(isImmediateKeystroke(NO_PASTE, typed('[200~alpha'), NOW)).toBe(false);
    expect(isImmediateKeystroke({ ...NO_PASTE, markerPiece: '[20' }, typed('a'), NOW)).toBe(false);
    expect(isImmediateKeystroke({ ...NO_PASTE, markerPiece: '[' }, typed('200~a'), NOW)).toBe(
      false,
    );
  });

  it('holds everything inside the burst window and inside an open paste', () => {
    expect(isImmediateKeystroke(inBurst, typed('a'), NOW + 10)).toBe(false);
    expect(isImmediateKeystroke(inBurst, typed('a'), NOW + PASTE_BURST_MS)).toBe(true);
    expect(isImmediateKeystroke(open, enter, NOW + PASTE_BURST_MS + 1)).toBe(false);
    expect(isImmediateKeystroke(open, typed('a'), NOW + PASTE_OPEN_IDLE_MS)).toBe(true);
  });
});

describe('outputsOf', () => {
  it('cleans a bracketed paste and never yields an empty text', () => {
    expect(outputsOf(bracketed(' a \n b '))).toEqual([text('a b')]);
    expect(outputsOf(bracketed(' \n '))).toEqual([]);
  });

  it('decodes a key run and drops an unresolved control sequence tail', () => {
    expect(outputsOf(typed('a\rb'))).toEqual([key('a'), key('', ENTER_KEY), key('b')]);
    expect(outputsOf(typed('[1;2m'))).toEqual([]);
  });
});
