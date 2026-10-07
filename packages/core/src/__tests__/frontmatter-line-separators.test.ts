import { describe, it, expect } from 'vitest';
import {
  MAX_FRONTMATTER_BLOCK_CHARS,
  MAX_FRONTMATTER_BLOCK_LINES,
} from '../parsers/frontmatter-recovery.js';
import { parseFrontmatter } from '../parsers/utils.js';
import { cpuTimeMs } from './cpu-time.js';

/**
 * U+2028 and U+2029 start a line for the multiline `^` of gray-matter's comment strip, though YAML
 * does not read them as line breaks. The guard's model of the strip, and its cap on line breaks,
 * must count them like LF, or a block padded with them costs the strip hundreds of milliseconds
 * while the guard sees one long line.
 */

const STRIP_CPU_BUDGET_MS = 100;
const PADDING_BREAKS = 1_990;
// 1 990 three-byte separators and these spaces stay under the 64 KiB block cap.
const PADDING_SPACES = 58_000;
const OVER_THE_LINE_CAP = MAX_FRONTMATTER_BLOCK_LINES + 100;

function skipReason(raw: string): string | null {
  const message = (parseFrontmatter(raw).recoveryCause as Error | undefined)?.message ?? '';
  return /^frontmatter skipped: (\w+)$/.exec(message)?.[1] ?? null;
}

describe.each([
  ['U+2028', '\u2028'],
  ['U+2029', '\u2029'],
])('%s as a line start', (_name, separator) => {
  it('counts toward the comment-strip budget: a few separators and a long run of spaces', () => {
    const padding = `${separator.repeat(PADDING_BREAKS)}${' '.repeat(PADDING_SPACES)}`;
    const raw = `---\nname: x\ntools: [a,${padding}b]\n---\nbody`;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);

    const { result, cpuMs } = cpuTimeMs(() => parseFrontmatter(raw));

    expect(cpuMs).toBeLessThan(STRIP_CPU_BUDGET_MS);
    expect(skipReason(raw)).toBe('oversize');
    expect(result.data).toEqual({ name: 'x' });
    expect(result.content).toBe('body');
  });

  it('counts toward the cap on line breaks, though each one holds no white space', () => {
    const raw = `---\nname: x\n${`k: v${separator}`.repeat(OVER_THE_LINE_CAP)}\n---\nbody`;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(MAX_FRONTMATTER_BLOCK_CHARS);

    expect(skipReason(raw)).toBe('oversize');
  });
});
