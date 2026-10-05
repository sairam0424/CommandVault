import { MAX_DESCRIPTION_LENGTH } from '../constants.js';
import type { ParsedFrontmatter } from '../types/index.js';

export interface DerivedDescription {
  readonly text: string;
  /** True when `text` came from the document body because the frontmatter had none. */
  readonly fromBody: boolean;
}

const HEADING = /^#{1,6}(?:\s|$)/;
const BACKTICK_FENCE = /^(`{3,})[^`]*$/;
const TILDE_FENCE = /^(~{3,})/;
const BACKTICK = '`';
const RULER = /^([-*_])(?:\s*\1){2,}$/;
const LONE_TAG = /^<\/?[A-Za-z][\w-]*(?:\s[^>]*)?>$/;
const QUOTE_MARKER = /^>+\s*/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const INLINE_CODE = /`([^`]*)`/g;
const STRONG = /(?<!\w)(\*\*|__)(?=\S)(.+?)(?<=\S)\1(?!\w)/g;
const STAR_EMPHASIS = /(?<![\w*])\*(?=[^*\s])([^*]+?)(?<=[^*\s])\*(?![\w*])/g;
const UNDERSCORE_EMPHASIS = /(?<![\w_])_(?=[^_\s])([^_]+?)(?<=[^_\s])_(?![\w_])/g;
const STRIKETHROUGH = /~~(?=\S)(.+?)(?<=\S)~~/g;
const DANGLING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
const ELLIPSIS = '…';
const COMMENT_START = '<!--';
const COMMENT_END = '-->';

/** Markdown stripping is quadratic on unclosed openers, so only this much of a line is examined. */
const SCAN_WINDOW_FACTOR = 4;
export const DESCRIPTION_SCAN_WINDOW = MAX_DESCRIPTION_LENGTH * SCAN_WINDOW_FACTOR;

function stripInlineMarkdown(line: string): string {
  return line
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(INLINE_CODE, '$1')
    .replace(STRONG, '$2')
    .replace(STAR_EMPHASIS, '$1')
    .replace(UNDERSCORE_EMPHASIS, '$1')
    .replace(STRIKETHROUGH, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedWindow(line: string): string {
  if (line.length <= DESCRIPTION_SCAN_WINDOW) return line;
  return line.slice(0, DESCRIPTION_SCAN_WINDOW).replace(DANGLING_HIGH_SURROGATE, '');
}

function toPlainText(line: string): string {
  if (RULER.test(line) || LONE_TAG.test(line)) return '';
  const unmarked = boundedWindow(line).replace(QUOTE_MARKER, '').replace(LIST_MARKER, '');
  return stripInlineMarkdown(unmarked);
}

function clampLength(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  const head = text.slice(0, MAX_DESCRIPTION_LENGTH - ELLIPSIS.length);
  return `${head.replace(DANGLING_HIGH_SURROGATE, '').trimEnd()}${ELLIPSIS}`;
}

interface CommentScan {
  /** The line with every HTML comment, or the part of one, removed. */
  readonly text: string;
  /** True when a comment is still open at the end of this line. */
  readonly isOpen: boolean;
}

/** Start offsets of every maximal backtick run in a line, grouped by run length, ascending. */
type BacktickRuns = ReadonlyMap<number, readonly number[]>;

function indexBacktickRuns(line: string): BacktickRuns {
  const runs = new Map<number, number[]>();
  let at = line.indexOf(BACKTICK);
  while (at !== -1) {
    let end = at + 1;
    while (line[end] === BACKTICK) end += 1;
    const starts = runs.get(end - at);
    if (starts === undefined) runs.set(end - at, [at]);
    else starts.push(at);
    at = line.indexOf(BACKTICK, end);
  }
  return runs;
}

/** The first entry of the ascending `starts` that is >= `from`, or -1. */
function firstStartFrom(starts: readonly number[], from: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] ?? 0) < from) low = mid + 1;
    else high = mid;
  }
  return low < starts.length ? (starts[low] ?? -1) : -1;
}

/** Index just past the inline code span opening at `at`, or past its backtick run if unclosed. */
function codeSpanEnd(runs: BacktickRuns, line: string, at: number): number {
  let runEnd = at;
  while (line[runEnd] === BACKTICK) runEnd += 1;
  const length = runEnd - at;
  const closer = firstStartFrom(runs.get(length) ?? [], runEnd);
  return closer === -1 ? runEnd : closer + length;
}

/** `indexOf` that reuses a previous answer while it still lies ahead; -1 stays -1 as `at` only grows. */
function nextIndex(line: string, needle: string, at: number, cached: number): number {
  return cached === -1 || cached >= at ? cached : line.indexOf(needle, at);
}

/**
 * Removes HTML comments from a line; `isOpen` carries a comment that spans several lines.
 * A comment marker inside an inline code span is literal text, not a comment.
 * Linear in the line length: each marker is looked up again only once the scan has passed it.
 */
function removeComments(line: string, startsOpen: boolean): CommentScan {
  let text = '';
  let at = 0;
  let isOpen = startsOpen;
  let open = line.indexOf(COMMENT_START);
  let tick = line.indexOf(BACKTICK);
  const runs = tick === -1 ? new Map<number, readonly number[]>() : indexBacktickRuns(line);
  while (at < line.length) {
    if (isOpen) {
      const end = line.indexOf(COMMENT_END, at);
      if (end === -1) break;
      at = end + COMMENT_END.length;
      isOpen = false;
      continue;
    }
    open = nextIndex(line, COMMENT_START, at, open);
    tick = nextIndex(line, BACKTICK, at, tick);
    if (open === -1 && tick === -1) {
      text += line.slice(at);
      break;
    }
    if (tick !== -1 && (open === -1 || tick < open)) {
      const spanEnd = codeSpanEnd(runs, line, tick);
      text += line.slice(at, spanEnd);
      at = spanEnd;
      continue;
    }
    text += line.slice(at, open);
    at = open + COMMENT_START.length;
    isOpen = true;
  }
  return { text: text.trim(), isOpen };
}

interface Fence {
  readonly marker: string;
  readonly length: number;
}

/** The fence a line opens, or null. A backtick fence's info string cannot contain a backtick. */
function openingFence(line: string): Fence | null {
  const match = BACKTICK_FENCE.exec(line) ?? TILDE_FENCE.exec(line);
  if (match === null) return null;
  const run = match[1] ?? '';
  return { marker: run.charAt(0), length: run.length };
}

/** True when the line closes `fence`: the same character, at least as long, nothing after it. */
function closesFence(line: string, fence: Fence): boolean {
  const run = line.replace(/\s+$/, '');
  return run.length >= fence.length && run === fence.marker.repeat(run.length);
}

/**
 * First line of running text in a markdown body: headings, blank lines, fenced code, HTML
 * comments and lines with no text once markdown is removed are skipped. Empty when the body
 * has none.
 */
export function firstBodyLine(body: string): string {
  let fence: Fence | null = null;
  let insideComment = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (fence !== null) {
      if (closesFence(trimmed, fence)) fence = null;
      continue;
    }
    if (!insideComment) {
      fence = openingFence(trimmed);
      if (fence !== null) continue;
    }
    const scan = removeComments(trimmed, insideComment);
    insideComment = scan.isOpen;
    const line = scan.text;
    if (line === '' || HEADING.test(line)) continue;
    const text = toPlainText(line);
    if (text !== '') return clampLength(text);
  }
  return '';
}

/** The declared description when it has text, else the first line of the body, else ''. */
export function deriveDescription(data: ParsedFrontmatter, body: string): DerivedDescription {
  const declared = typeof data.description === 'string' ? data.description.trim() : '';
  if (declared !== '') return { text: declared, fromBody: false };
  const text = firstBodyLine(body);
  return { text, fromBody: text !== '' };
}

/** Metadata recording where a derived description came from; empty for a declared one. */
export function descriptionMetadata(derived: DerivedDescription): Record<string, unknown> {
  return derived.fromBody ? { descriptionSource: 'body' } : {};
}
