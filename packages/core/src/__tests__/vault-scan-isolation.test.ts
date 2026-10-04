import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from '../vault.js';
import type { ParserPlugin } from '../parsers/parser-registry.js';
import type { ParserResult, VaultEntry } from '../types/index.js';

/**
 * These tests drive a real Vault end to end. The default parser registry is a process-wide
 * singleton, so every test re-imports a fresh copy of the module, and HOME/USERPROFILE point at a
 * temp dir so nothing a test does can resolve to the developer's real home.
 */

interface VaultInternals {
  pendingChanges: Map<string, Set<string>>;
  flushPendingChanges(): Promise<void>;
}

let root: string;
let claudeDir: string;
let vault: Vault | null;

async function writeSkill(dirName: string, name: string, description: string): Promise<string> {
  const dir = join(claudeDir, 'skills', dirName);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'SKILL.md');
  await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
  return filePath;
}

async function writeSettings(hooks: unknown): Promise<void> {
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ hooks }), 'utf-8');
}

async function openVault(): Promise<Vault> {
  vi.resetModules();
  const { createVault } = await import('../vault.js');
  const opened = createVault({
    claudeConfigPath: claudeDir,
    dbPath: join(root, 'vault.db'),
    enableWatcher: false,
    defaultSearchTier: 'minisearch',
    projectRoot: join(root, 'project'),
  });
  vault = opened;
  return opened;
}

function throwingPlugin(type: string, failure: () => Promise<ParserResult>): ParserPlugin {
  return {
    type,
    displayName: type,
    emoji: 'x',
    color: 'red',
    globPatterns: [],
    parse: failure,
  };
}

function makeImported(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'imported0001',
    name: 'imported-skill',
    type: 'skill',
    source: 'custom',
    description: 'imported record',
    filePath: join(root, 'imported', 'SKILL.md'),
    tags: ['imported'],
    metadata: {},
    content: 'imported body',
    lastModified: new Date('2025-01-01T00:00:00.000Z'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cv-vault-isolation-'));
  claudeDir = join(root, 'claude');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(join(root, 'project'), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('USERPROFILE', join(root, 'home'));
  vault = null;
});

afterEach(async () => {
  await vault?.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Vault: a throwing parser never fails a scan', () => {
  it('initialize() survives a parser that throws synchronously and keeps the other parsers', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    v.getRegistry().register(
      throwingPlugin('rule', () => {
        throw new TypeError('rule parser exploded');
      }),
    );

    await expect(v.initialize()).resolves.toBeDefined();

    expect(v.getEntriesByType('skill').map((e) => e.name)).toEqual(['one']);
    const failure = v.getErrors().find((e) => e.parser === 'rule');
    expect(failure?.message).toContain('rule parser exploded');
  });

  it('initialize() survives a parser whose promise rejects', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    v.getRegistry().register(
      throwingPlugin('agent', () => Promise.reject(new Error('agent down'))),
    );

    await expect(v.initialize()).resolves.toBeDefined();

    expect(v.getEntriesByType('skill')).toHaveLength(1);
    expect(v.getErrors().some((e) => e.parser === 'agent')).toBe(true);
  });

  it('emits the parser failure on the error event', async () => {
    const v = await openVault();
    v.getRegistry().register(
      throwingPlugin('command', () => Promise.reject(new Error('command down'))),
    );
    const seen: string[] = [];
    v.on('error', (err) => seen.push(err.message));

    await v.initialize();

    expect(seen.some((m) => m.includes('command down'))).toBe(true);
  });

  it('scanSingle() survives a throwing parser and keeps the other types', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    await v.initialize();
    v.getRegistry().register(throwingPlugin('rule', () => Promise.reject(new Error('rule down'))));

    await expect(v.scanSingle('rule')).resolves.toBeUndefined();

    expect(v.getEntriesByType('skill')).toHaveLength(1);
    expect(v.getErrors().some((e) => e.parser === 'rule')).toBe(true);
  });

  it('a watcher flush survives a throwing parser and keeps the other types', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    await v.initialize();
    v.getRegistry().register(
      throwingPlugin('plugin', () => Promise.reject(new Error('plugin down'))),
    );
    const internals = v as unknown as VaultInternals;
    internals.pendingChanges.set('plugin', new Set(['a', 'b']));

    await expect(internals.flushPendingChanges()).resolves.toBeUndefined();

    expect(v.getEntriesByType('skill')).toHaveLength(1);
    expect(v.getErrors().some((e) => e.parser === 'plugin')).toBe(true);
  });
});

describe('Vault: entry ids are unique after a scan', () => {
  async function openWithDuplicateSkills(): Promise<Vault> {
    await writeSkill('a-dir', 'shared', 'alpha skill');
    await writeSkill('b-dir', 'shared', 'beta skill');
    await writeSkill('c-dir', 'unique-skill', 'gamma skill');
    const v = await openVault();
    await v.initialize();
    return v;
  }

  it('keeps the first duplicate by sorted filePath and records a duplicate id error', async () => {
    const v = await openWithDuplicateSkills();

    const ids = v.getAllEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    const shared = v.getAllEntries().filter((e) => e.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].filePath).toBe(join(claudeDir, 'skills', 'a-dir', 'SKILL.md'));

    const dupErrors = v.getErrors().filter((e) => e.message.startsWith('duplicate id '));
    expect(dupErrors).toHaveLength(1);
    expect(dupErrors[0].message).toContain(join(claudeDir, 'skills', 'a-dir', 'SKILL.md'));
    expect(dupErrors[0].message).toContain(join(claudeDir, 'skills', 'b-dir', 'SKILL.md'));
    expect(dupErrors[0].filePath).toBe(join(claudeDir, 'skills', 'b-dir', 'SKILL.md'));
  });

  it('answers the first default-tier search without throwing and returns both unique results', async () => {
    const v = await openWithDuplicateSkills();

    const results = v.search({ query: 'skill' });

    expect(results.map((r) => r.entry.name).sort()).toEqual(['shared', 'unique-skill']);
    expect(v.suggest('uniq')).toBeDefined();
  });

  it('keeps getStats and getAllEntries in agreement', async () => {
    const v = await openWithDuplicateSkills();

    expect(v.getStats().totalEntries).toBe(v.getAllEntries().length);
  });

  it('lets saveSnapshot and getDiff run on a vault that had duplicates', async () => {
    const v = await openWithDuplicateSkills();

    expect(() => v.saveSnapshot()).not.toThrow();
    const diff = v.getDiff();

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it('collapses two hooks that run the same script with different arguments', async () => {
    await writeSettings({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node /opt/hooks/guard.js --strict' },
            { type: 'command', command: 'node /opt/hooks/guard.js --lenient' },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node /opt/hooks/notify.js' }] }],
    });
    const v = await openVault();

    await expect(v.initialize()).resolves.toBeDefined();

    const hooks = v.getEntriesByType('hook').map((e) => e.name);
    expect(hooks.sort()).toEqual(['PreToolUse:Bash:guard', 'Stop:*:notify']);
    expect(v.getErrors().filter((e) => e.message.startsWith('duplicate id '))).toHaveLength(1);
  });

  it('restores the dropped duplicate when the winner is deleted and the watcher flushes', async () => {
    const winnerPath = await writeSkill('a-dir', 'shared', 'alpha skill');
    await writeSkill('b-dir', 'shared', 'beta skill');
    const v = await openVault();
    await v.initialize();
    expect(v.getAllEntries().filter((e) => e.name === 'shared')).toHaveLength(1);
    await rm(join(claudeDir, 'skills', 'a-dir'), { recursive: true, force: true });
    const internals = v as unknown as VaultInternals;
    internals.pendingChanges.set('skill', new Set([winnerPath]));

    await internals.flushPendingChanges();

    const shared = v.getAllEntries().filter((e) => e.name === 'shared');
    expect(shared.map((e) => e.filePath)).toEqual([join(claudeDir, 'skills', 'b-dir', 'SKILL.md')]);
    expect(v.getErrors().filter((e) => e.message.startsWith('duplicate id '))).toEqual([]);
  });

  it('drops a new file that collides with an existing skill when the watcher flushes it', async () => {
    const existingPath = await writeSkill('a-dir', 'shared', 'alpha skill');
    const v = await openVault();
    await v.initialize();
    expect(v.getErrors().filter((e) => e.message.startsWith('duplicate id '))).toEqual([]);
    const newPath = await writeSkill('b-dir', 'shared', 'beta skill');
    const internals = v as unknown as VaultInternals;
    internals.pendingChanges.set('skill', new Set([newPath]));

    await expect(internals.flushPendingChanges()).resolves.toBeUndefined();

    const shared = v.getAllEntries().filter((e) => e.name === 'shared');
    expect(shared.map((e) => e.filePath)).toEqual([existingPath]);
    const dupErrors = v.getErrors().filter((e) => e.message.startsWith('duplicate id '));
    expect(dupErrors).toHaveLength(1);
    expect(dupErrors[0].filePath).toBe(newPath);
    expect(v.getStats().totalEntries).toBe(v.getAllEntries().length);
    expect(v.search({ query: 'shared' })).toHaveLength(1);
  });

  it('does not pile up duplicate errors across repeated partial rescans', async () => {
    await writeSkill('a-dir', 'shared', 'alpha skill');
    await writeSkill('b-dir', 'shared', 'beta skill');
    const v = await openVault();
    await v.initialize();

    await v.scanSingle('skill');
    await v.scanSingle('skill');

    expect(v.getErrors().filter((e) => e.message.startsWith('duplicate id '))).toHaveLength(1);
    expect(v.getStats().totalEntries).toBe(v.getAllEntries().length);
  });
});

describe('Vault.addEntries: imported records are validated', () => {
  it('rejects malformed records, reports them, and still adds the valid ones', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    await v.initialize();
    const good = makeImported();
    const batch = [
      good,
      null,
      'garbage',
      makeImported({ id: 'bad-date', lastModified: 'yesterday' as unknown as Date }),
      makeImported({ id: 'bad-tags', tags: 'a,b' as unknown as string[] }),
    ] as unknown as readonly VaultEntry[];

    const added = await v.addEntries(batch);

    expect(added).toBe(1);
    expect(v.getAllEntries().map((e) => e.id)).toContain(good.id);
    expect(v.getErrors().filter((e) => e.parser === 'import')).toHaveLength(4);
    expect(v.getStats().totalEntries).toBe(v.getAllEntries().length);
    expect(v.search({ query: 'imported' }).length).toBeGreaterThan(0);
  });

  it('keeps ids unique when an imported record collides with an existing entry', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    await v.initialize();
    const existing = v.getAllEntries().find((e) => e.name === 'one')!;
    const colliding = makeImported({
      id: existing.id,
      filePath: join(root, 'zzz-imported', 'SKILL.md'),
    });

    const added = await v.addEntries([colliding, makeImported({ id: 'imported0002' })]);

    const ids = v.getAllEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(added).toBe(1);
    expect(v.getErrors().some((e) => e.message.startsWith(`duplicate id ${existing.id}`))).toBe(
      true,
    );
    expect(v.getStats().totalEntries).toBe(v.getAllEntries().length);
    expect(v.search({ query: 'imported' }).length).toBeGreaterThan(0);
  });

  it('returns 0 and leaves the vault untouched when every record is malformed', async () => {
    await writeSkill('one', 'one', 'first skill');
    const v = await openVault();
    await v.initialize();
    const before = v.getAllEntries().length;

    const added = await v.addEntries([null, 42] as unknown as readonly VaultEntry[]);

    expect(added).toBe(0);
    expect(v.getAllEntries()).toHaveLength(before);
  });
});
