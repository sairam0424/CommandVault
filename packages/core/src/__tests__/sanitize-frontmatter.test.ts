import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_FRONTMATTER_DEPTH,
  MAX_FRONTMATTER_NODES,
  MAX_FRONTMATTER_STRING_CHARS,
  sanitizeFrontmatter,
} from '../parsers/sanitize-frontmatter.js';
import { parseAgents } from '../parsers/agent-parser.js';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';
import { manyKeys } from './hostile-claude-dir.js';

/**
 * Whatever the YAML engine hands back, the frontmatter every consumer sees is a plain, bounded
 * tree: `JSON.stringify(entry.metadata)` never throws and never grows past a few hundred KiB.
 * The objects here are built directly, without YAML, so each bound is tested on its own.
 */

const FAN_OUT = 9;
const BOMB_LEVELS = 8;
const TIME_BUDGET_MS = 100;
const KEY_COUNT = 10_000;
const FILE_KEY_COUNT = 7000;

function countNodes(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((n, v) => n + countNodes(v), 0);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return 1 + Object.values(value).reduce<number>((n, v) => n + countNodes(v), 0);
  }
  return 1;
}

/** `levels` nested objects around the leaf: nest(0) is the leaf itself. */
function nest(levels: number, leaf: unknown = 1): unknown {
  return levels === 0 ? leaf : { a: nest(levels - 1, leaf) };
}

function innermost(value: unknown, levels: number): unknown {
  let current = value;
  for (let i = 0; i < levels; i += 1) current = (current as { a: unknown }).a;
  return current;
}

function aliasDag(): unknown[] {
  let level: unknown[] = Array<string>(FAN_OUT).fill('lol');
  for (let i = 1; i < BOMB_LEVELS; i += 1) level = Array<unknown>(FAN_OUT).fill(level);
  return level;
}

describe('sanitizeFrontmatter', () => {
  it('cuts a 9^8 alias DAG down to the node budget in bounded time', () => {
    const data = { name: 'laughs', 'allowed-tools': aliasDag() };
    const started = performance.now();

    const result = sanitizeFrontmatter(data);

    expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
    expect(result.dropped).toBeGreaterThan(0);
    expect(countNodes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_NODES);
    expect(result.data.name).toBe('laughs');
    expect(() => JSON.stringify(result.data)).not.toThrow();
  });

  it('counts every visit of a shared object, not unique objects', () => {
    const shared = { k: 'v' };
    const data = { list: Array<unknown>(MAX_FRONTMATTER_NODES).fill(shared) };

    const result = sanitizeFrontmatter(data);

    expect(result.dropped).toBeGreaterThan(0);
    expect(countNodes(result.data)).toBeLessThanOrEqual(MAX_FRONTMATTER_NODES);
  });

  it('turns a self-referencing array into null instead of throwing', () => {
    const loop: unknown[] = [];
    loop.push(loop);
    const data = { 'allowed-tools': loop };

    const result = sanitizeFrontmatter(data);

    expect(result.data['allowed-tools']).toEqual([null]);
    expect(result.dropped).toBe(1);
    expect(() => JSON.stringify(result.data)).not.toThrow();
  });

  it('turns a self-referencing object into null', () => {
    const self: Record<string, unknown> = { name: 'me' };
    self.self = self;

    const result = sanitizeFrontmatter(self);

    expect(result.data).toEqual({ name: 'me', self: null });
    expect(result.dropped).toBe(1);
  });

  it('keeps a value at the depth limit and drops one level deeper', () => {
    const kept = sanitizeFrontmatter(nest(MAX_FRONTMATTER_DEPTH) as Record<string, unknown>);
    const cut = sanitizeFrontmatter(nest(MAX_FRONTMATTER_DEPTH + 1) as Record<string, unknown>);

    expect(kept.dropped).toBe(0);
    expect(kept.data).toEqual(nest(MAX_FRONTMATTER_DEPTH));
    expect(cut.dropped).toBe(1);
    expect(innermost(cut.data, MAX_FRONTMATTER_DEPTH)).toEqual({});
  });

  // The limit as documented, not as exported: the test above follows the constant wherever it goes.
  it('keeps eight levels and cuts the ninth', () => {
    expect(sanitizeFrontmatter(nest(8) as Record<string, unknown>).dropped).toBe(0);
    expect(sanitizeFrontmatter(nest(9) as Record<string, unknown>).dropped).toBe(1);
  });

  it('cuts a 70 K-character string to the limit and counts the cut', () => {
    const result = sanitizeFrontmatter({ description: 'x'.repeat(70 * 1024) });

    expect((result.data.description as string).length).toBe(MAX_FRONTMATTER_STRING_CHARS);
    expect(result.dropped).toBe(1);
  });

  it('keeps Dates, null, undefined, numbers and booleans; drops functions, symbols and instances', () => {
    const when = new Date('2026-10-07T00:00:00Z');
    const data = {
      when,
      nothing: null,
      missing: undefined,
      count: 3,
      flag: true,
      fn: () => 'no',
      sym: Symbol('no'),
      big: BigInt(1),
      buffer: Buffer.from('no'),
      map: new Map([['a', 1]]),
    };

    const result = sanitizeFrontmatter(data);

    expect(result.data).toEqual({ when, nothing: null, missing: undefined, count: 3, flag: true });
    expect(result.data.when).toBeInstanceOf(Date);
    expect(result.dropped).toBe(5);
    expect(() => JSON.stringify(result.data)).not.toThrow();
  });

  it('cuts a 10 K-key object down to the node budget', () => {
    const data = Object.fromEntries(Array.from({ length: KEY_COUNT }, (_, i) => [`k${i}`, i]));

    const result = sanitizeFrontmatter(data);

    expect(result.dropped).toBe(KEY_COUNT + 1 - MAX_FRONTMATTER_NODES);
    expect(countNodes(result.data)).toBe(MAX_FRONTMATTER_NODES);
  });

  it('copies benign frontmatter deep-equal into new objects', () => {
    const data = {
      name: 'ok',
      keywords: ['a', 'b'],
      author: { name: 'x', url: 'https://example.test' },
      version: 2,
    };

    const result = sanitizeFrontmatter(data);

    expect(result.dropped).toBe(0);
    expect(result.data).toEqual(data);
    expect(result.data).not.toBe(data);
    expect(result.data.keywords).not.toBe(data.keywords);
    expect(result.data.author).not.toBe(data.author);
  });
});

describe('a parser applies the sanitizer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-sanitize-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('truncates a 7000-key agent frontmatter with one warning and still indexes it', async () => {
    const agentsDir = join(tempDir, 'agents');
    await mkdir(agentsDir);
    const filePath = join(agentsDir, 'keys.md');
    await writeFile(filePath, manyKeys('keys', FILE_KEY_COUNT));

    const result = await parseAgents(agentsDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('keys');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(filePath);
    expect(result.errors[0].message).toMatch(/frontmatter truncated \(\d+ values dropped\)/);
    expect(getParseSeverity(result.errors[0])).toBe('warning');
  });

  it.each([
    ['a .cursor/rules file', '.cursor/rules/keys.mdc'],
    ['a project CLAUDE.md', 'CLAUDE.md'],
  ])(
    'truncates the frontmatter of %s under --project with one warning',
    async (_what, relative) => {
      const projectRoot = join(tempDir, 'project');
      const filePath = join(projectRoot, relative);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, manyKeys('keys', FILE_KEY_COUNT));

      const result = await detectAgentConfigs(projectRoot);

      expect(result.entries.filter((entry) => entry.filePath === filePath)).toHaveLength(1);
      const warnings = result.errors.filter((error) => error.filePath === filePath);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/frontmatter truncated \(\d+ values dropped\)/);
      expect(getParseSeverity(warnings[0])).toBe('warning');
    },
  );
});
