import { describe, it, expect } from 'vitest';
import { getContentExcerpt } from '../utils/excerpt.js';

describe('getContentExcerpt', () => {
  it('no match → returns first maxLines lines, matchLine is null', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = getContentExcerpt(content, 'zzznomatch');
    expect(result.matchLine).toBeNull();
    expect(result.lines).toHaveLength(12);
    expect(result.lines[0]).toBe('line 1');
    expect(result.lines[11]).toBe('line 12');
  });

  it('match in middle → window centred around match line, matchLine points to it in returned array', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[14] = 'target word here'; // 0-indexed line 14 (15th line)
    const content = lines.join('\n');
    const result = getContentExcerpt(content, 'target', 12);
    expect(result.matchLine).not.toBeNull();
    // The matched line should be within the returned array
    expect(result.lines[result.matchLine!]).toBe('target word here');
    expect(result.lines).toHaveLength(12);
  });

  it('match on first line → matchLine is 0', () => {
    const lines = ['target line', ...Array.from({ length: 20 }, (_, i) => `line ${i + 2}`)];
    const content = lines.join('\n');
    const result = getContentExcerpt(content, 'target', 12);
    expect(result.matchLine).toBe(0);
    expect(result.lines[0]).toBe('target line');
  });

  it('match on last line → matchLine is last index of returned lines', () => {
    const lines = [...Array.from({ length: 20 }, (_, i) => `line ${i + 1}`), 'final target'];
    const content = lines.join('\n');
    const result = getContentExcerpt(content, 'target', 12);
    expect(result.matchLine).not.toBeNull();
    expect(result.lines[result.matchLine!]).toBe('final target');
    // matchLine should be the last index of returned lines
    expect(result.matchLine).toBe(result.lines.length - 1);
  });

  it('content shorter than maxLines → returns all lines', () => {
    const content = 'line 1\nline 2\nline 3';
    const result = getContentExcerpt(content, 'zzznomatch', 12);
    expect(result.lines).toHaveLength(3);
    expect(result.matchLine).toBeNull();
  });

  it('case-insensitive matching', () => {
    const content = 'first\nSECOND line\nthird';
    const result = getContentExcerpt(content, 'second', 12);
    expect(result.matchLine).not.toBeNull();
    expect(result.lines[result.matchLine!]).toBe('SECOND line');
  });

  it('multi-word query → any token matches', () => {
    const content = 'apple\nbanana split\ncherry';
    const result = getContentExcerpt(content, 'banana cherry', 12);
    // Should match on the first token found — "banana" is on line index 1
    expect(result.matchLine).not.toBeNull();
    expect(result.lines[result.matchLine!]).toContain('banana');
  });

  it('empty content → returns empty lines, null matchLine', () => {
    const result = getContentExcerpt('', 'anything', 12);
    expect(result.lines).toHaveLength(0);
    expect(result.matchLine).toBeNull();
  });

  it('uses default maxLines of 12 when not specified', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = getContentExcerpt(content, 'zzznomatch');
    expect(result.lines).toHaveLength(12);
  });

  it('window is centred: match line sits roughly in the middle', () => {
    // 40 lines, match at line index 20 (21st line), window of 12
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    lines[20] = 'MATCH here';
    const content = lines.join('\n');
    const result = getContentExcerpt(content, 'MATCH', 12);
    expect(result.matchLine).not.toBeNull();
    expect(result.lines[result.matchLine!]).toBe('MATCH here');
    // The window should be centred so matchLine is near the middle index (≈ 5-6 for window of 12)
    const mid = Math.floor(12 / 2);
    expect(result.matchLine).toBeGreaterThanOrEqual(mid - 1);
    expect(result.matchLine).toBeLessThanOrEqual(mid + 1);
  });
});
