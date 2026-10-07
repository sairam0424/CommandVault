import type { ParseError, ParsedFrontmatter } from '../types/index.js';

/**
 * The frontmatter every consumer sees is a plain, bounded tree, whatever the YAML engine built:
 * `JSON.stringify(entry.metadata)` must never throw (a circular anchor) and never grow past a hard
 * cap of bytes (an alias DAG of 9^8 shared elements fits in 458 bytes of YAML, and one string of
 * 48 000 characters that 1500 aliases repeat is 72 MB). The copy keeps strings, numbers, booleans,
 * null, undefined and Dates, recurses into arrays and plain objects, and drops everything else.
 * Every VISIT counts against the node budget and the character budget, because an alias DAG is
 * shared references: a set of seen objects would let it through. The character budget is spent on
 * every string and key as it is visited, a shared string once per visit, so it bounds the size of
 * the copy and not only its shape.
 */

export const MAX_FRONTMATTER_STRING_CHARS = 65536;
export const MAX_FRONTMATTER_DEPTH = 8;
export const MAX_FRONTMATTER_NODES = 2000;
/** Characters of strings and keys the copy may hold in all: four times the biggest string. */
export const MAX_FRONTMATTER_TOTAL_CHARS = 4 * MAX_FRONTMATTER_STRING_CHARS;
/**
 * What `JSON.stringify` of the copy can come to, at worst: six bytes for each budgeted character
 * (a control character or a lone surrogate escapes to `\uXXXX`; a three-byte character is no more
 * than that) plus the quotes, colons, commas and brackets of at most MAX_FRONTMATTER_NODES nodes.
 */
export const MAX_FRONTMATTER_JSON_BYTES = 2 * 1024 * 1024;
/** The copy of a source holds at most this many times the source's characters, plus a slack. */
export const FRONTMATTER_SOURCE_FACTOR = 4;
export const FRONTMATTER_SOURCE_SLACK_CHARS = 4096;

export interface SanitizedFrontmatter {
  readonly data: ParsedFrontmatter;
  /** Values left out or cut: dropped kinds, cycles, depth and budget overruns, shortened strings. */
  readonly dropped: number;
}

interface Budget {
  visits: number;
  /** Characters of strings and keys spent so far, and the most that may be. */
  chars: number;
  readonly charLimit: number;
  dropped: number;
}

const DROPPED = Symbol('dropped');

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Spends `length` characters of the budget; false, with the budget untouched, when they do not fit. */
function spendChars(length: number, budget: Budget): boolean {
  if (budget.chars + length > budget.charLimit) {
    budget.dropped += 1;
    return false;
  }
  budget.chars += length;
  return true;
}

function copyString(value: string, budget: Budget): string | typeof DROPPED {
  const cut = value.length > MAX_FRONTMATTER_STRING_CHARS;
  const kept = cut ? value.slice(0, MAX_FRONTMATTER_STRING_CHARS) : value;
  if (cut) budget.dropped += 1;
  return spendChars(kept.length, budget) ? kept : DROPPED;
}

function copyArray(
  value: readonly unknown[],
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: Budget,
): unknown[] {
  const inside = new Set(ancestors).add(value);
  return value
    .map((item) => copyValue(item, depth + 1, inside, budget))
    .filter((item) => item !== DROPPED);
}

function copyObject(
  value: Record<string, unknown>,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: Budget,
): Record<string, unknown> {
  const inside = new Set(ancestors).add(value);
  const kept: (readonly [string, unknown])[] = [];
  for (const [key, item] of Object.entries(value)) {
    // A key over the string cap, or past the budget, goes with the value it names.
    if (key.length > MAX_FRONTMATTER_STRING_CHARS) {
      budget.dropped += 1;
      continue;
    }
    if (!spendChars(key.length, budget)) continue;
    const copied = copyValue(item, depth + 1, inside, budget);
    if (copied !== DROPPED) kept.push([key, copied]);
  }
  return Object.fromEntries(kept);
}

function copyValue(
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: Budget,
): unknown {
  budget.visits += 1;
  if (budget.visits > MAX_FRONTMATTER_NODES || depth > MAX_FRONTMATTER_DEPTH) {
    budget.dropped += 1;
    return DROPPED;
  }
  switch (typeof value) {
    case 'string':
      return copyString(value, budget);
    case 'number':
    case 'boolean':
    case 'undefined':
      return value;
    case 'object':
      break;
    default:
      budget.dropped += 1;
      return DROPPED;
  }
  if (value === null) return null;
  if (value instanceof Date) return value;
  if (ancestors.has(value)) {
    budget.dropped += 1;
    return null;
  }
  if (Array.isArray(value)) return copyArray(value, depth, ancestors, budget);
  if (isPlainObject(value)) return copyObject(value, depth, ancestors, budget);
  budget.dropped += 1;
  return DROPPED;
}

/**
 * A bounded plain copy of parsed frontmatter, and how many values the copy had to leave out. The
 * root counts as a node too, so the copy never holds more than MAX_FRONTMATTER_NODES in total, and
 * its strings and keys never hold more than MAX_FRONTMATTER_TOTAL_CHARS characters (so its JSON
 * stays under MAX_FRONTMATTER_JSON_BYTES). Given the length of the text the data was parsed from,
 * it also holds at most FRONTMATTER_SOURCE_FACTOR times that many characters, plus a slack: a copy
 * cannot weigh more than the file it came from, whatever shared references the parser built.
 */
export function sanitizeFrontmatter(
  data: Readonly<Record<string, unknown>>,
  sourceChars?: number,
): SanitizedFrontmatter {
  const charLimit =
    sourceChars === undefined
      ? MAX_FRONTMATTER_TOTAL_CHARS
      : Math.min(
          MAX_FRONTMATTER_TOTAL_CHARS,
          FRONTMATTER_SOURCE_FACTOR * sourceChars + FRONTMATTER_SOURCE_SLACK_CHARS,
        );
  const budget: Budget = { visits: 0, chars: 0, charLimit, dropped: 0 };
  const copied = copyValue(data, 0, new Set(), budget);
  const plain =
    typeof copied === 'object' && copied !== null && !Array.isArray(copied) ? copied : {};
  return { data: plain as ParsedFrontmatter, dropped: budget.dropped };
}

/** The warning a parser reports once when the copy had to leave values out. */
export function truncatedFrontmatterWarning(
  label: string,
  filePath: string,
  dropped: number,
): ParseError {
  return {
    filePath,
    message: `${label} frontmatter truncated (${dropped} values dropped): only a bounded plain copy of it is indexed`,
    severity: 'warning',
  };
}
