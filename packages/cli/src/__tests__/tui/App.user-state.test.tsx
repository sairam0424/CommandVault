import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup } from 'ink-testing-library';
import { Vault } from '@commandvault/core';
import { TEST_TIMEOUT_MS, mountApp } from './harness.js';

const { exitMock } = vi.hoisted(() => ({ exitMock: vi.fn() }));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

vi.mock('clipboardy', () => ({ default: { write: vi.fn().mockResolvedValue(undefined) } }));

// The TUI opens with every entry, most used first. The uses and favorites an earlier process
// recorded are in the database, and the list has to show them before any search. `beta` sorts
// last by id and second by name, so it comes first only when its uses are read.
const USED_SKILL = 'beta';
const FAVORITE_SKILL = 'gamma';
const OTHER_SKILL = 'alpha';
const USES = 3;

function writeSkill(claudeDir: string, name: string): void {
  const dir = join(claudeDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.\n`,
  );
}

function entryId(vault: Vault, name: string): string {
  const entry = vault.getAllEntries().find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no entry named ${name}`);
  return entry.id;
}

describe(
  'App on a fresh vault over rows an earlier process marked',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let root: string;
    let vault: Vault;

    beforeAll(async () => {
      root = mkdtemp();
      const claudeDir = join(root, 'claude');
      for (const name of [USED_SKILL, OTHER_SKILL, FAVORITE_SKILL]) writeSkill(claudeDir, name);
      const config = {
        claudeConfigPath: claudeDir,
        dbPath: join(root, 'data', 'vault.db'),
        enableWatcher: false,
        defaultSearchTier: 'fuse' as const,
      };

      const earlier = new Vault(config);
      await earlier.initialize();
      for (let use = 0; use < USES; use++) earlier.recordUsage(entryId(earlier, USED_SKILL));
      earlier.toggleFavorite(entryId(earlier, FAVORITE_SKILL));
      await earlier.dispose();

      vault = new Vault(config);
      await vault.initialize();
    });

    afterEach(() => {
      cleanup();
    });

    afterAll(async () => {
      await vault.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('lists the most used entry first with its count, and stars the favorite, before any search', async () => {
      const { waitForFrame, frame } = await mountApp(vault, { columns: 100, rows: 30 });
      await waitForFrame(
        (f) => f.includes(USED_SKILL) && f.includes(OTHER_SKILL) && f.includes(FAVORITE_SKILL),
      );

      const shown = frame();
      expect(shown.indexOf(USED_SKILL), shown).toBeLessThan(shown.indexOf(OTHER_SKILL));
      expect(shown.indexOf(USED_SKILL), shown).toBeLessThan(shown.indexOf(FAVORITE_SKILL));
      expect(shown).toMatch(new RegExp(`${USED_SKILL}.*×${USES}\\b`));
      expect(shown).toMatch(new RegExp(`★ ${FAVORITE_SKILL}`));
    });
  },
);

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'cv-tui-user-state-'));
}
