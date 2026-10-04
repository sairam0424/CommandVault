import matter from 'gray-matter';
import type { ParsedFrontmatter } from '../types/index.js';

/**
 * How a frontmatter block was recovered after strict YAML parsing failed.
 * - quoted: the offending single-line values were quoted and the full YAML then parsed.
 * - line-based: YAML was abandoned; only name and description were read line by line.
 */
export type FrontmatterRecovery = 'quoted' | 'line-based';

export interface ParsedFrontmatterResult {
  readonly data: ParsedFrontmatter;
  readonly content: string;
  readonly recovery?: FrontmatterRecovery;
  /** The strict-parse error that triggered the recovery. */
  readonly recoveryCause?: unknown;
}

type RecoveredFrontmatter = Pick<ParsedFrontmatterResult, 'data' | 'content' | 'recovery'>;

const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TOP_LEVEL_SCALAR = /^([A-Za-z0-9_][\w.-]*):[ \t]+(\S.*)$/;
const INDENTED_LINE = /^[ \t]+\S/;
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?\d*$/;
const ALREADY_SAFE_START = /^["'|>&*!]/;
const RECOVERABLE_KEYS = ['name', 'description'] as const;

// Code-execution engines are stubbed so a hostile file cannot run JS on parse.
const DISABLED_ENGINES = {
  javascript: { parse: () => ({}) },
  coffee: { parse: () => ({}) },
  js: { parse: () => ({}) },
};

export function parseStrict(raw: string): { data: ParsedFrontmatter; content: string } {
  const { data, content } = matter(raw, { engines: DISABLED_ENGINES });
  return { data: data as ParsedFrontmatter, content: content.trim() };
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
  } catch {
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
