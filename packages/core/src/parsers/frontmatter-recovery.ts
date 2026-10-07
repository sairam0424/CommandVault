import matter from 'gray-matter';
import type { ParsedFrontmatter } from '../types/index.js';
import { AliasLimitError, createAliasMeter, type YamlListener } from './yaml-alias-meter.js';

/**
 * How a frontmatter block was recovered after strict YAML parsing failed, or was never attempted.
 * - quoted: the offending single-line values were quoted and the full YAML then parsed.
 * - line-based: YAML was abandoned; only name and description were read line by line.
 */
export type FrontmatterRecovery = 'quoted' | 'line-based';

export interface ParsedFrontmatterResult {
  readonly data: ParsedFrontmatter;
  readonly content: string;
  readonly recovery?: FrontmatterRecovery;
  /** The strict-parse error that triggered the recovery, or why the block was never parsed. */
  readonly recoveryCause?: unknown;
}

type RecoveredFrontmatter = Pick<ParsedFrontmatterResult, 'data' | 'content' | 'recovery'>;

/**
 * Why a frontmatter block is not handed to the YAML engine at all.
 * - oversize: the block is over MAX_FRONTMATTER_BLOCK_CHARS, never closes within that much, runs
 *   over MAX_FRONTMATTER_BLOCK_LINES line breaks, or would cost gray-matter's comment strip more
 *   than MAX_COMMENT_STRIP_STEPS.
 * - aliases: the YAML engine resolved a second alias while parsing it (see yaml-alias-meter), the
 *   smallest shape that can multiply (an alias DAG) or repeat a long string.
 */
export type FrontmatterGuardReason = 'oversize' | 'aliases';

export const MAX_FRONTMATTER_BLOCK_CHARS = 65536;
// gray-matter strips comments with /^\s*#[^\n]+/gm before any engine runs. At every line start
// `\s*` swallows the rest of a white-space run and backtracks over it when no `#` follows, so a run
// of n characters holding k line starts costs about k x n steps: a 64 KiB block of blank lines
// costs seconds of CPU. Real frontmatter has tens of lines; 2000 is far past the longest tool or
// trigger list. The cap bounds k only: the budget below bounds the product.
export const MAX_FRONTMATTER_BLOCK_LINES = 2000;
// Steps the strip may cost, counted per white-space run as (line starts in it + 1) x its length and
// summed over the block. Measured on shapes sized to 98.5% of the budget: 20-25 ms of CPU per file
// when the block parses first time, and about 47 ms on the path where the strict parse fails and the
// quoting recovery runs the strip a second time. Ordinary frontmatter, indentation and blank lines
// included, is some thousands of steps; a thousand blank lines in a row would be a million.
export const MAX_COMMENT_STRIP_STEPS = 5_000_000;
// Where `^` matches in a multiline regex, so these are the line starts gray-matter pays for: LF, a
// bare CR, U+2028 and U+2029. CRLF is one break for the cap, and two line starts for the strip.
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;
const WHITE_SPACE_RUNS = /\s+/g;

const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TOP_LEVEL_SCALAR = /^([A-Za-z0-9_][\w.-]*):[ \t]+(\S.*)$/;
const INDENTED_LINE = /^[ \t]+\S/;
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?\d*$/;
const ALREADY_SAFE_START = /^["'|>&*!]/;
const RECOVERABLE_KEYS = ['name', 'description'] as const;

// gray-matter's opener is `---` with no fourth dash. The rest of that first line is the engine
// name: gray-matter trims it with String.prototype.trim (so any Unicode white space, a bare CR
// included, may surround it), lowercases it and routes the block to js-yaml or JSON.parse, or
// throws before any parse when it does not know the name. The guard therefore reads the whole
// line as the name and never validates it: guarding a block behind a name gray-matter rejects
// costs nothing. When the trimmed name is empty the block starts right after `---`, white space
// and all, exactly as gray-matter slices it.
const OPENER = '---';
const BOM = '\uFEFF';
const LINE_END = /\r?\n/;
// gray-matter's closer: the first newline followed by `---`, wherever it is; none means the
// whole rest of the file is the block.
const CLOSER = '\n---';
const CLOSER_DASHES = '---';
const LINE_FEED = 0x0a;
// Code-execution engines are stubbed so a hostile file cannot run JS on parse.
const DISABLED_ENGINES = {
  javascript: { parse: () => ({}) },
  coffee: { parse: () => ({}) },
  js: { parse: () => ({}) },
};

type YamlParse = (text: string, options?: { listener?: YamlListener }) => unknown;

/**
 * gray-matter's own YAML engine (`yaml.safeLoad` of the js-yaml it ships with), which takes js-yaml's
 * options as its second argument. It is read off `matter.engines`, so the guard meters exactly the
 * parser gray-matter would have used and core takes no dependency of its own on js-yaml. If a
 * gray-matter release stops exposing it, every parse fails here instead of running unmetered.
 */
function grayMatterYamlParse(): YamlParse {
  const engines = (matter as unknown as { engines?: { yaml?: { parse?: unknown } } }).engines;
  const parse = engines?.yaml?.parse;
  if (typeof parse !== 'function') {
    throw new Error(
      'gray-matter exposes no YAML engine, so the frontmatter aliases cannot be counted',
    );
  }
  return parse as YamlParse;
}

/** A YAML engine for one parse: the engine gray-matter uses, with the alias meter attached. */
function meteredYamlEngine(): { parse: (text: string) => object } {
  const parseYaml = grayMatterYamlParse();
  const meter = createAliasMeter();
  return {
    parse: (text) => {
      const parsed = parseYaml(text, { listener: meter.listener });
      meter.requireObserved(parsed);
      return parsed as object;
    },
  };
}

/**
 * Parses the frontmatter with js-yaml. The parse stops, with an AliasLimitError, at the second
 * alias the engine resolves; any other failure is the engine's own YAML error.
 */
export function parseStrict(raw: string): { data: ParsedFrontmatter; content: string } {
  const engines = { ...DISABLED_ENGINES, yaml: meteredYamlEngine() };
  const { data, content } = matter(raw, { engines });
  return { data: data as ParsedFrontmatter, content: content.trim() };
}

/**
 * Where the closer starts in `text`, or -1: the same position `text.indexOf(CLOSER)` finds. It is
 * found by looking for the dashes and checking the character before them, because a block made of
 * newlines makes every position a candidate for a search that starts with `\n` (half a second per
 * 32 MiB in V8), while `-` is rare there. A `---` that does not follow a newline sends the search
 * to the next newline: no closer can start before it.
 */
function indexOfCloser(text: string): number {
  let from = 0;
  for (;;) {
    const dashes = text.indexOf(CLOSER_DASHES, from);
    if (dashes === -1) return -1;
    if (dashes > 0 && text.charCodeAt(dashes - 1) === LINE_FEED) return dashes - 1;
    const newline = text.indexOf('\n', dashes);
    if (newline === -1) return -1;
    from = newline;
  }
}

/** The block exactly as gray-matter would hand it to an engine, and the body after it. */
function splitLikeGrayMatter(raw: string): { yaml: string; body: string } | null {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  if (!text.startsWith(OPENER) || text.charAt(OPENER.length) === '-') return null;
  const afterOpener = text.slice(OPENER.length);
  const lineEnd = afterOpener.search(LINE_END);
  // gray-matter's own quirk: with no newline at all, the name is the rest but its last character.
  const languageRaw = lineEnd === -1 ? afterOpener.slice(0, -1) : afterOpener.slice(0, lineEnd);
  const rest = languageRaw.trim() === '' ? afterOpener : afterOpener.slice(languageRaw.length);
  const closeAt = indexOfCloser(rest);
  if (closeAt === -1) return { yaml: rest, body: '' };
  const body = rest.slice(closeAt + CLOSER.length).replace(/^\r?\n/, '');
  return { yaml: rest.slice(0, closeAt), body };
}

/** True once the block holds more line breaks than the cap; it stops counting there. */
function exceedsLineCap(yaml: string): boolean {
  let breaks = 0;
  for (const _break of yaml.matchAll(LINE_BREAKS)) {
    breaks += 1;
    if (breaks > MAX_FRONTMATTER_BLOCK_LINES) return true;
  }
  return false;
}

function isLineBreak(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/**
 * True when gray-matter's comment strip would cost more than MAX_COMMENT_STRIP_STEPS on the block:
 * the sum, over its white-space runs, of the run's length times the line starts it holds (plus the
 * run's own start). An upper bound on the regex's work, computed in one linear pass; it stops
 * counting once over.
 */
function exceedsStripBudget(yaml: string): boolean {
  let steps = 0;
  for (const run of yaml.matchAll(WHITE_SPACE_RUNS)) {
    const text = run[0];
    let lineStarts = 1;
    for (let index = 0; index < text.length; index += 1) {
      if (isLineBreak(text.charCodeAt(index))) lineStarts += 1;
    }
    steps += lineStarts * text.length;
    if (steps > MAX_COMMENT_STRIP_STEPS) return true;
  }
  return false;
}

/**
 * Decides, from the raw text and before any YAML engine runs, whether a frontmatter block is too
 * big to parse: over the size caps, or costing gray-matter's comment strip too much. Null leaves
 * the block to the parser. What the YAML itself holds (aliases) is the parser's to say.
 */
function refusedBeforeParse(raw: string): FrontmatterGuardReason | null {
  const parts = splitLikeGrayMatter(raw);
  if (!parts) return null;
  if (parts.yaml.length > MAX_FRONTMATTER_BLOCK_CHARS) return 'oversize';
  if (Buffer.byteLength(parts.yaml, 'utf8') > MAX_FRONTMATTER_BLOCK_CHARS) return 'oversize';
  if (exceedsLineCap(parts.yaml) || exceedsStripBudget(parts.yaml)) return 'oversize';
  return null;
}

/** Why a block's YAML was never turned into data, and the cause a skipped result carries. */
export class FrontmatterSkippedError extends Error {
  readonly reason: FrontmatterGuardReason;

  constructor(reason: FrontmatterGuardReason) {
    super(`frontmatter skipped: ${reason}`);
    this.name = 'FrontmatterSkippedError';
    this.reason = reason;
  }
}

/**
 * What a guarded file yields: name and description read line by line when present, otherwise no
 * data at all; the body is kept either way, so the file is still indexed under its name.
 */
export function recoverSkippedFrontmatter(
  raw: string,
  reason: FrontmatterGuardReason,
): ParsedFrontmatterResult {
  const parts = splitLikeGrayMatter(raw) ?? { yaml: '', body: raw };
  // Name and description sit in the first lines, and an oversize block can be the whole 32 MiB
  // file: splitting all of it into lines would cost some twenty times its size in heap.
  const head = parts.yaml.slice(0, MAX_FRONTMATTER_BLOCK_CHARS);
  const recovered = recoverByLines(head, parts.body) ?? {
    data: {},
    content: parts.body.trim(),
    recovery: 'line-based' as const,
  };
  return { ...recovered, recoveryCause: new FrontmatterSkippedError(reason) };
}

function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  const match = FRONTMATTER_BLOCK.exec(raw);
  if (!match) return null;
  return { yaml: match[1], body: raw.slice(match[0].length) };
}

function parsesAlone(line: string): boolean {
  try {
    parseStrict(`---\n${line}\n---\n`);
    return true;
  } catch {
    // A line that fails on its own is exactly what the caller is looking for.
    return false;
  }
}

function quoteIfBroken(line: string, nextLine: string | undefined): string {
  const match = TOP_LEVEL_SCALAR.exec(line);
  if (!match) return line;
  const [, key, value] = match;
  const trimmed = value.trim();
  if (ALREADY_SAFE_START.test(trimmed)) return line;
  // A continuation line means the value spans lines, so one line alone proves nothing.
  if (nextLine !== undefined && INDENTED_LINE.test(nextLine)) return line;
  if (parsesAlone(line)) return line;
  // JSON string syntax is a YAML double-quoted scalar, so this escapes safely.
  return `${key}: ${JSON.stringify(trimmed)}`;
}

function recoverByQuoting(yaml: string, body: string): RecoveredFrontmatter | null {
  const lines = yaml.split(/\r?\n/);
  const quoted = lines.map((line, index) => quoteIfBroken(line, lines[index + 1]));
  if (quoted.every((line, index) => line === lines[index])) return null;
  try {
    const parsed = parseStrict(`---\n${quoted.join('\n')}\n---\n${body}`);
    return { ...parsed, recovery: 'quoted' };
  } catch (error) {
    // The quoted text can reach aliases the failed parse never got to: that is the guard's answer.
    if (error instanceof AliasLimitError) throw error;
    // Quoting was not enough; the caller falls through to the line-based extractor.
    return null;
  }
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      // Not valid JSON escapes; strip the quotes and keep the text verbatim.
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function readBlockScalar(lines: readonly string[], start: number, indicator: string): string {
  const collected: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === '') continue;
    if (!INDENTED_LINE.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(indicator.startsWith('|') ? '\n' : ' ');
}

function readTopLevelValue(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index === -1) return undefined;
  const raw = lines[index].slice(prefix.length).trim();
  const value = BLOCK_SCALAR_INDICATOR.test(raw) ? readBlockScalar(lines, index + 1, raw) : raw;
  const cleaned = unquote(value).trim();
  return cleaned === '' ? undefined : cleaned;
}

function recoverByLines(yaml: string, body: string): RecoveredFrontmatter | null {
  const lines = yaml.split(/\r?\n/);
  const found = RECOVERABLE_KEYS.flatMap((key) => {
    const value = readTopLevelValue(lines, key);
    return value === undefined ? [] : [[key, value] as const];
  });
  if (found.length === 0) return null;
  return {
    data: Object.fromEntries(found) as ParsedFrontmatter,
    content: body.trim(),
    recovery: 'line-based',
  };
}

/**
 * Recovers what it can from frontmatter that strict YAML parsing rejected.
 * Returns null when there is no frontmatter block or nothing usable in it, so the
 * caller can rethrow the original error and keep the file unindexed as before.
 */
export function recoverFrontmatter(raw: string): RecoveredFrontmatter | null {
  const parts = splitFrontmatter(raw);
  if (!parts) return null;
  return recoverByQuoting(parts.yaml, parts.body) ?? recoverByLines(parts.yaml, parts.body);
}

function recoverAfterYamlError(raw: string, strictError: unknown): ParsedFrontmatterResult {
  let recovered: RecoveredFrontmatter | null;
  try {
    recovered = recoverFrontmatter(raw);
  } catch (recoveryError) {
    if (recoveryError instanceof AliasLimitError) return recoverSkippedFrontmatter(raw, 'aliases');
    throw recoveryError;
  }
  if (!recovered) throw strictError;
  return { ...recovered, recoveryCause: strictError };
}

/**
 * The frontmatter of a file, whatever it holds. A block over the size caps is never handed to
 * gray-matter. Any other block is parsed once, with the alias meter attached: a second alias stops
 * the parse and the block is read line by line instead, on the strict path and on the recovery
 * path alike (the recovery re-parses the same block, quoted). A YAML error goes to the recovery;
 * if nothing can be recovered the error is thrown, as before.
 */
export function parseGuarded(raw: string): ParsedFrontmatterResult {
  const reason = refusedBeforeParse(raw);
  if (reason !== null) return recoverSkippedFrontmatter(raw, reason);
  try {
    return parseStrict(raw);
  } catch (strictError) {
    if (strictError instanceof AliasLimitError) return recoverSkippedFrontmatter(raw, 'aliases');
    return recoverAfterYamlError(raw, strictError);
  }
}

/**
 * Why `parseGuarded` skips the YAML of `raw`, or null when it parses it (or when the engine rejects
 * the block outright and nothing is recovered: no data was built, so nothing was skipped).
 */
export function guardFrontmatter(raw: string): FrontmatterGuardReason | null {
  try {
    const { recoveryCause } = parseGuarded(raw);
    return recoveryCause instanceof FrontmatterSkippedError ? recoveryCause.reason : null;
  } catch {
    // The same rejection parseFrontmatter raises; this predicate only answers whether it was a skip.
    return null;
  }
}
