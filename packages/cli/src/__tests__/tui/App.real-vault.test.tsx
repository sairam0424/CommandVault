import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup } from 'ink-testing-library';
import { Vault } from '@commandvault/core';
import { KEYS, TEST_TIMEOUT_MS, mountApp } from './harness.js';

const { exitMock } = vi.hoisted(() => ({ exitMock: vi.fn() }));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

vi.mock('clipboardy', () => ({ default: { write: vi.fn().mockResolvedValue(undefined) } }));

// The TUI searches with the fuzzy tier, which returns what the parsers produced (no favorite, no
// usage count, content cut to the indexed start). These tests run the real vault and the real
// tier, because a stub returns whatever the test puts in it.
const LONG_SKILL_LINES = 200;
const LONG_SKILL_LAST_LINE = `row-${LONG_SKILL_LINES - 1}`;
const PAGES_TO_REACH_THE_END = 60;
// The hint bar and the toast carry a star too; only a row has one right before an entry name.
const FAVORITE_ROW = /★ (styleguide|longform)/;

function writeSkill(claudeDir: string, name: string, description: string, body: string): void {
  const dir = join(claudeDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

describe('App on a real vault and the real fuzzy tier', { timeout: TEST_TIMEOUT_MS }, () => {
  let root: string;
  let vault: Vault;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cv-tui-real-'));
    const claudeDir = join(root, 'claude');
    writeSkill(claudeDir, 'styleguide', 'house style rules', 'Short body.');
    writeSkill(claudeDir, 'longform', 'a long document', longBody());
    vault = new Vault({
      claudeConfigPath: claudeDir,
      dbPath: join(root, 'data', 'vault.db'),
      enableWatcher: false,
      defaultSearchTier: 'fuse',
    });
    await vault.initialize();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    // Windows refuses to delete a file another handle still has open, so the vault's database
    // connection has to go before its directory does (EBUSY on the runner otherwise).
    await vault.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('shows the star of a favorite in the list, after a search, and right after Ctrl+F', async () => {
    const { write, waitForFrame, frame } = await mountApp(vault, { columns: 100, rows: 30 });
    await waitForFrame((f) => f.includes('styleguide'));
    expect(frame()).not.toMatch(FAVORITE_ROW);

    await write(KEYS.ctrlF);
    await waitForFrame((f) => FAVORITE_ROW.test(f));
    const starred = FAVORITE_ROW.exec(frame())?.[1] ?? '';

    await write(starred.slice(0, 4));
    await waitForFrame((f) => f.includes(`★ ${starred}`) && f.includes('▶'));
  });

  it('shows the usage count once Enter has copied an entry', async () => {
    const { write, waitForFrame, frame } = await mountApp(vault, { columns: 100, rows: 30 });
    await waitForFrame((f) => f.includes('longform'));
    expect(frame()).not.toContain('×');

    await write(KEYS.enter);

    await waitForFrame((f) => /×1\b/.test(f));
  });

  it('pages a long entry to its last line while a query is typed', async () => {
    const { write, waitForFrame } = await mountApp(vault, { columns: 100, rows: 30 });
    await write('longform');
    await waitForFrame((f) => f.includes('row-0'));

    for (let page = 0; page < PAGES_TO_REACH_THE_END; page++) await write(KEYS.pageDown);

    await waitForFrame((f) => f.includes(LONG_SKILL_LAST_LINE));
  });
});

function longBody(): string {
  return Array.from({ length: LONG_SKILL_LINES }, (_, i) => `row-${i}`).join('\n');
}
