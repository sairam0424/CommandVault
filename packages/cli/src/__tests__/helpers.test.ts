import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import {
  truncate,
  formatDate,
  typeEmoji,
  typeColor,
  printParseProblems,
  headlineProblem,
} from '../helpers.js';
import type { EntryType, ParseError } from '@commandvault/core';

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

describe('printParseProblems', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let previousLevel: typeof chalk.level;

  beforeEach(() => {
    previousLevel = chalk.level;
    chalk.level = 1;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    chalk.level = previousLevel;
    errorSpy.mockRestore();
  });

  const lines = (): string[] => errorSpy.mock.calls.map((call) => String(call[0]));
  const problem = (message: string, severity?: 'error' | 'warning'): ParseError => ({
    filePath: 'f',
    message,
    ...(severity === undefined ? {} : { severity }),
  });

  it('prints nothing when there is nothing to report', () => {
    printParseProblems([]);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('lists errors first in red, then warnings in yellow, then the counts', () => {
    printParseProblems([problem('w1', 'warning'), problem('e1', 'error'), problem('e2')]);

    expect(lines()).toEqual([
      chalk.red('  ✗ e1'),
      chalk.red('  ✗ e2'),
      chalk.yellow('  ⚠ w1'),
      chalk.red('  2 errors, 1 warning'),
    ]);
  });

  it('summarises a warning-only list in yellow', () => {
    printParseProblems([problem('w1', 'warning')]);

    expect(lines().at(-1)).toBe(chalk.yellow('  0 errors, 1 warning'));
  });

  it('caps the list and says how many were left out', () => {
    const many = Array.from({ length: 13 }, (_unused, index) => problem(`e${index}`, 'error'));

    printParseProblems(many);

    expect(lines().filter((line) => line.includes('✗'))).toHaveLength(10);
    expect(lines()).toContain(chalk.dim('  ... and 3 more'));
    expect(lines().at(-1)).toBe(chalk.red('  13 errors, 0 warnings'));
  });
});

describe('headlineProblem', () => {
  it('prefers the first error over an earlier warning', () => {
    const warning: ParseError = { filePath: 'a', message: 'w', severity: 'warning' };
    const error: ParseError = { filePath: 'b', message: 'e', severity: 'error' };

    expect(headlineProblem([warning, error])).toBe(error);
  });

  it('falls back to the first problem when there is no error', () => {
    const warning: ParseError = { filePath: 'a', message: 'w', severity: 'warning' };

    expect(headlineProblem([warning])).toBe(warning);
    expect(headlineProblem([])).toBeUndefined();
  });
});
