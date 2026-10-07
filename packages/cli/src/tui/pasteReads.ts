import type { Key } from 'ink';
import {
  NO_KEY,
  PASTE_START_TAIL,
  decodeInput,
  isControlSequenceTail,
  isPasteEndTail,
  isPasteLike,
  isPasteStartFragment,
  isResolvedKey,
  isTypedRun,
  rawBytes,
} from './keys.js';
import { flattenPaste, pasteText } from './pasteText.js';

/**
 * A raw paste (no bracketed paste markers) reaches the process in pty-sized pieces, 1 KiB each on
 * macOS, and the last piece can be a few bytes ending in a newline, or be the newline alone. A
 * run of unresolved bytes, or of nothing but Enter and Tab, that follows a paste piece within
 * this window is still the paste, never typed keys: a person does not type within 150 ms of
 * pasting. Every other key Ink resolved (Esc, Ctrl+C, an arrow) stays a key inside the window.
 * Only raw pieces open the window: a bracketed paste arrives whole, so what follows it is keys.
 */
export const PASTE_BURST_MS = 150;

/**
 * A bracketed paste whose start marker was put back together here arrives as keys, piece by
 * piece, and is the paste up to its end marker however far apart the pieces are: pasted bytes
 * must never act. Should the end marker never come (a marker typed or pasted raw, a cut link),
 * this much silence after the last piece closes the paste so keys are keys again; keys pressed
 * meanwhile are swallowed, and do not count as pieces.
 */
export const PASTE_OPEN_IDLE_MS = 5000;

const SPACE = ' ';
const BRACKET = PASTE_START_TAIL.slice(0, 1);

/** One event Ink emitted for the current stdin read: a key, or the body of a bracketed paste. */
export type ReadEvent =
  | { readonly kind: 'key'; readonly input: string; readonly key: Key }
  | { readonly kind: 'paste'; readonly text: string };

export type KeyReadEvent = ReadEvent & { readonly kind: 'key' };

/** What a read amounts to, in order: pasted text for the box, or a key for the key handler. */
export type ReadOutput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly input: string; readonly key: Key };

/** What is carried from one stdin read to the next to tell a paste from keys. */
export interface PasteState {
  /** Reads before this time continue the raw paste whose piece came last. */
  readonly burstUntil: number;
  /** Reads before this time are the body of a reassembled bracketed paste still awaiting its end. */
  readonly openUntil: number;
  /** The last piece ended on a word boundary that its trimming removed. */
  readonly separatorPending: boolean;
  /**
   * The piece of a bracketed paste's start marker the last read consisted of, when Ink flushed
   * one: a lone `[` is a key and was typed, so it is only remembered; a longer piece is held back
   * until the next read shows whether the rest of the marker follows. Empty otherwise.
   */
  readonly markerPiece: string;
}

export const NO_PASTE: PasteState = {
  burstUntil: 0,
  openUntil: 0,
  separatorPending: false,
  markerPiece: '',
};

export interface ResolvedRead {
  readonly state: PasteState;
  readonly outputs: readonly ReadOutput[];
}

const isKeyEvent = (event: ReadEvent): event is KeyReadEvent => event.kind === 'key';

/** Enter and Tab: resolved keys that, inside a raw paste, are its line and column breaks. */
const isSeparatorKey = (event: KeyReadEvent): boolean => event.key.return || event.key.tab;

/** The held piece of a start marker, if the last read left one (a typed `[` is not held). */
const isHeldPiece = (piece: string): boolean => isPasteStartFragment(piece, NO_KEY);

const isPasteEndEvent = (event: ReadEvent): boolean =>
  event.kind === 'key' && isPasteEndTail(event.input, event.key);

/** A bracketed paste Ink delivered whole, on its own channel. */
const isBracketedEvent = (event: ReadEvent): boolean => event.kind === 'paste';

/**
 * The keys of a read are a raw paste when their unresolved bytes together look pasted, or when
 * they follow a paste piece inside the burst window. Ink cuts a read at every escape sequence, so
 * the bytes are judged as a whole: a coloured paste begins with a short plain line that, judged
 * alone, would pass for typed text and an Enter. Inside the window a read of nothing but Enter and
 * Tab is the paste as well: a CR-ended paste one byte over a pty piece boundary ends in a piece
 * that is exactly its final line break, which as a key would act on an entry.
 */
function isRawPaste(keys: readonly KeyReadEvent[], inBurst: boolean): boolean {
  if (keys.length === 0) return false;
  const unresolved = keys.filter((event) => !isResolvedKey(event.key));
  if (inBurst) return unresolved.length > 0 || keys.every(isSeparatorKey);
  if (unresolved.length === 0) return false;
  return isPasteLike(unresolved.map((event) => rawBytes(event.input)).join(''), NO_KEY);
}

/**
 * The bytes of a read event as pasted text: an unresolved event is the bytes the terminal sent
 * (an escape sequence Ink stripped the ESC from gets it back, so it is dropped whole), Enter and
 * Tab separate words, other keys vanish.
 */
function pastedBytes(event: ReadEvent): string {
  if (event.kind === 'paste') return event.text;
  if (!isResolvedKey(event.key)) return rawBytes(event.input);
  return isSeparatorKey(event) ? SPACE : '';
}

/** The events as one line of pasted text, edges kept (see flattenPaste). */
const textOf = (events: readonly ReadEvent[]): string =>
  flattenPaste(events.map(pastedBytes).join(''));

/** The read was nothing but a piece of a start marker Ink flushed: that piece, else undefined. */
function markerPieceOf(events: readonly ReadEvent[]): string | undefined {
  const [event] = events;
  if (events.length !== 1 || event?.kind !== 'key') return undefined;
  const typedBracket = event.input === BRACKET && !isResolvedKey(event.key);
  return typedBracket || isPasteStartFragment(event.input, event.key) ? event.input : undefined;
}

/**
 * The read continues the start marker whose piece came before it: its first event begins with the
 * marker's remaining bytes, which are stripped, and the rest of the read is the paste. With no
 * piece seen the remainder is the whole marker, which heads the body when Ink flushed the ESC
 * alone (that ESC was the Escape key to Ink and to the app, nothing here can tell them apart).
 */
function markerBodyOf(
  events: readonly ReadEvent[],
  piece: string,
): readonly ReadEvent[] | undefined {
  const remainder = PASTE_START_TAIL.slice(piece.length);
  const [first, ...rest] = events;
  if (first?.kind !== 'key' || isResolvedKey(first.key)) return undefined;
  if (!first.input.startsWith(remainder)) return undefined;
  return [{ ...first, input: first.input.slice(remainder.length) }, ...rest];
}

/** A held piece that no marker followed was text after all: it rejoins the read, ahead of it. */
function withHeldPiece(events: readonly ReadEvent[], piece: string): readonly ReadEvent[] {
  if (!isHeldPiece(piece)) return events;
  return [{ kind: 'key', input: piece, key: NO_KEY }, ...events];
}

/**
 * A key event as keys: an escape sequence Ink did not know (a focus report, a stray colour code)
 * is no key and no text, typed its tail would land in the search box; a run of bytes is split into
 * its text and its control keys. A bracketed paste Ink delivered whole is its cleaned text.
 */
export function outputsOf(event: ReadEvent): readonly ReadOutput[] {
  if (event.kind === 'paste') {
    const cleaned = pasteText(event.text);
    return cleaned ? [{ kind: 'text', text: cleaned }] : [];
  }
  if (isControlSequenceTail(event.input, event.key)) return [];
  return decodeInput(event.input, event.key).map(({ input, key }) => ({ kind: 'key', input, key }));
}

/**
 * How long the reassembled bracketed paste stays open after this read: a piece of its body (any
 * event that is not a key Ink resolved) restarts the idle ceiling; a read of nothing but resolved
 * keys, an Enter or an Esc pressed while the paste waits for an end marker that may never come,
 * leaves the ceiling where it was, so pressing keys cannot keep the paste open for good.
 */
function openUntilAfter(state: PasteState, events: readonly ReadEvent[], now: number): number {
  const hasPiece = events.some((event) => event.kind === 'paste' || !isResolvedKey(event.key));
  return hasPiece ? now + PASTE_OPEN_IDLE_MS : state.openUntil;
}

/**
 * The events as one piece of pasted text. Pieces of one paste are trimmed one by one; a boundary
 * that fell on whitespace is put back. A piece of a still-open bracketed paste keeps it open.
 */
function insertPaste(
  state: PasteState,
  events: readonly ReadEvent[],
  continues: boolean,
  now: number,
  keepOpen: boolean,
): ResolvedRead {
  const flat = textOf(events);
  const text = flat.trim();
  const separatorBefore = continues && state.separatorPending;
  const leadingSpace = separatorBefore || (continues && flat.startsWith(SPACE));
  const outputs: ReadOutput[] = text
    ? [{ kind: 'text', text: leadingSpace ? SPACE + text : text }]
    : [];
  return {
    state: {
      ...NO_PASTE,
      burstUntil: now + PASTE_BURST_MS,
      openUntil: keepOpen ? openUntilAfter(state, events, now) : 0,
      separatorPending: text ? flat.endsWith(SPACE) : separatorBefore || flat.length > 0,
    },
    outputs,
  };
}

/**
 * A read of a reassembled bracketed paste, the one whose start marker Ink broke. An end marker in
 * it closes the paste as Ink closes a whole one: the window shuts and the next read is keys. What
 * follows the marker inside this read arrived in the same stdin read as pasted bytes, so it is
 * text, never a key (the boundary rule of resolveRead). A raw paste never comes here: an end
 * marker inside one is pasted bytes (a copied terminal log, hostile clipboard text), an escape
 * sequence the cleaner drops whole, and what follows it is text.
 */
function pasteRead(
  state: PasteState,
  events: readonly ReadEvent[],
  continues: boolean,
  now: number,
  keepOpen: boolean,
): ResolvedRead {
  const end = events.findIndex(isPasteEndEvent);
  if (end === -1) return insertPaste(state, events, continues, now, keepOpen);
  const body = events.filter((_, index) => index !== end);
  return { state: NO_PASTE, outputs: insertPaste(state, body, continues, now, false).outputs };
}

/**
 * A read holding a bracketed paste Ink delivered whole and keys with it: the keys arrived in the
 * same stdin read as pasted bytes, so they are text where printable and nothing otherwise. No
 * window opens: a whole bracketed paste has no pieces that could follow it.
 */
function textRead(state: PasteState, events: readonly ReadEvent[]): ResolvedRead {
  const text = textOf(events).trim();
  return { state, outputs: text ? [{ kind: 'text', text }] : [] };
}

/**
 * A key handled the moment it arrives: a plain keystroke that is no piece of a start marker,
 * continues none, follows no held piece (which must be typed first, in order), and falls in no
 * paste window.
 */
export function isImmediateKeystroke(state: PasteState, event: ReadEvent, now: number): boolean {
  if (now < state.burstUntil || now < state.openUntil) return false;
  if (isHeldPiece(state.markerPiece)) return false;
  if (event.kind === 'paste') return true;
  if (isPasteStartFragment(event.input, event.key)) return false;
  const remainder = PASTE_START_TAIL.slice(state.markerPiece.length);
  if (!isResolvedKey(event.key) && event.input.startsWith(remainder)) return false;
  return isTypedRun(event.input, event.key);
}

/**
 * What one finished stdin read amounts to, and the state the next read starts from. `held` is
 * every event not handled the moment it arrived, `seen` every event of the read.
 *
 * Paste-or-keys is decided per read: a read that continues a broken start marker, or falls inside
 * an open reassembled paste, is the paste up to its end marker; a read whose keys look pasted, or
 * that follows a raw piece inside the burst window, is a raw paste; a read that is a piece of a
 * start marker is held; a read Ink delivered a bracketed paste in is text; everything else is keys.
 *
 * The boundary rule: a read that carries pasted bytes of any kind is text to its last byte. Only
 * a script or a terminal multiplexer puts keys in the same stdin read as a paste, a person cannot,
 * so a key in such a read is text where printable and nothing otherwise, and never acts on an
 * entry. The one key this cannot reach is a resolved key Ink emits first in the read, handled
 * before the paste behind it is known (see isImmediateKeystroke).
 */
export function resolveRead(
  state: PasteState,
  held: readonly ReadEvent[],
  seen: readonly ReadEvent[],
  now: number,
): ResolvedRead {
  const inBurst = now < state.burstUntil;
  const body = markerBodyOf(held, state.markerPiece);
  if (body) return pasteRead(state, body, inBurst, now, true);
  if (now < state.openUntil) return pasteRead(state, held, true, now, true);
  const events = withHeldPiece(held, state.markerPiece);
  const piece = markerPieceOf(withHeldPiece(seen, state.markerPiece));
  const next = { ...state, markerPiece: piece ?? '' };
  if (piece !== undefined && isHeldPiece(piece)) return { state: next, outputs: [] };
  if (isRawPaste(events.filter(isKeyEvent), inBurst))
    return insertPaste(next, events, inBurst, now, false);
  if (seen.some(isBracketedEvent)) return textRead(next, events);
  return { state: next, outputs: events.flatMap(outputsOf) };
}
