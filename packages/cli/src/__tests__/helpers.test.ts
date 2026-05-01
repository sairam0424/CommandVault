import { describe, it, expect } from 'vitest';
import { truncate, formatDate, typeEmoji, typeColor } from '../helpers.js';
import type { EntryType } from '@commandvault/core';

describe('truncate', () => {
  it('returns string unchanged if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis when exceeding limit', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
  });

  it('handles exact-length strings', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('formatDate', () => {
  it('returns "just now" for very recent dates', () => {
    const date = new Date(Date.now() - 10_000);
    expect(formatDate(date)).toBe('just now');
  });

  it('returns minutes ago for recent past', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatDate(date)).toMatch(/5 minutes ago/);
  });

  it('returns hours ago', () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatDate(date)).toMatch(/3 hours ago/);
  });

  it('returns days ago', () => {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(formatDate(date)).toMatch(/2 days ago/);
  });

  it('returns "just now" for future dates', () => {
    const date = new Date(Date.now() + 60_000);
    expect(formatDate(date)).toBe('just now');
  });
});

describe('typeEmoji', () => {
  it('returns correct emoji for each entry type', () => {
    const types: EntryType[] = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'];
    for (const type of types) {
      const emoji = typeEmoji(type);
      expect(emoji).toBeTruthy();
      expect(emoji).not.toBe('?');
    }
  });
});

describe('typeColor', () => {
  it('returns a function for each entry type', () => {
    const types: EntryType[] = ['skill', 'agent', 'command', 'plugin', 'rule', 'hook'];
    for (const type of types) {
      const colorFn = typeColor(type);
      expect(typeof colorFn).toBe('function');
      expect(colorFn('test')).toContain('test');
    }
  });
});
