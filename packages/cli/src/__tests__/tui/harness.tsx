import React from 'react';
import { vi, expect } from 'vitest';
import { render } from 'ink-testing-library';
import type { Vault, VaultEntry } from '@commandvault/core';

export const POLL_TIMEOUT_MS = 10_000;
// Each key press is a full Ink render; Windows CI runners are the slow case.
export const TEST_TIMEOUT_MS = 30_000;

// Real control bytes, exactly what a terminal in raw mode delivers.
export const KEYS = {
  ctrlC: '\x03',
  ctrlF: '\x06',
  ctrlO: '\x0f',
  escape: '\x1b',
  enter: '\r',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
} as const;

export function makeEntry(name: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: name,
    name,
    type: 'skill',
    source: 'custom',
    description: `${name} description`,
    filePath: `/fake/${name}.md`,
    tags: [],
    metadata: {},
    content: `Content of ${name}`,
    lastModified: new Date('2026-01-01'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

type SearchFn = (options: { query: string }) => VaultEntry[];

/**
 * A vault double. `onSearch` decides what a typed query finds; without it every
 * query finds every entry.
 */
export function makeVault(entries: VaultEntry[], onSearch?: SearchFn): Vault {
  const find = onSearch ?? (() => entries);
  return {
    search: vi
      .fn()
      .mockImplementation((options: { query: string }) =>
        find(options).map((entry) => ({ entry, score: 1, matchedFields: [] as string[] })),
      ),
    getAllEntries: vi.fn().mockReturnValue(entries),
    recordUsage: vi.fn(),
    toggleFavorite: vi.fn().mockReturnValue(true),
    getSlashCommand: vi.fn().mockImplementation((e: VaultEntry) => `/${e.name}`),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Vault;
}

// Ink applies the state update of a key on React's next scheduler turn. One
// macrotask after each write lets the frame settle without a wall-clock wait.
const yieldToReact = () => new Promise<void>((done) => setImmediate(done));

// Colour support differs between CI runners; compare on the plain text.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export interface MountOptions {
  readonly columns?: number;
  readonly rows?: number;
}

export async function mountApp(vault: Vault, options: MountOptions = {}) {
  const { App } = await import('../../tui/App.js');
  const app = render(<App vault={vault} />);
  const frame = () => (app.lastFrame() ?? '').replace(ANSI_PATTERN, '');
  // Each call is ONE stdin read, however many keys the string holds.
  const write = async (chunk: string) => {
    app.stdin.write(chunk);
    await yieldToReact();
  };
  const waitForFrame = (predicate: (f: string) => boolean) =>
    vi.waitFor(() => expect(predicate(frame()), `last frame:\n${frame()}`).toBe(true), {
      timeout: POLL_TIMEOUT_MS,
      interval: 10,
    });
  // The fake stdout has a fixed 100-column getter; shadow it per instance and
  // emit the event a real terminal sends when its window changes size.
  const resize = async (columns: number, rows: number) => {
    Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true });
    app.stdout.emit('resize');
    await yieldToReact();
  };
  if (options.columns !== undefined && options.rows !== undefined) {
    await resize(options.columns, options.rows);
  }
  return { frame, write, waitForFrame, resize };
}

export type MountedApp = Awaited<ReturnType<typeof mountApp>>;
