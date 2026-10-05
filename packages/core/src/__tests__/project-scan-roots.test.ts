import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { Vault } from '../vault.js';
import { createVault } from '../vault.js';
import type { ParseError, VaultEntry } from '../types/index.js';

/**
 * `VaultConfig.projectRoot` is the only way a project directory gets indexed. Without it the vault
 * reads the Claude config directory and the account-level agent configs under the home directory,
 * and nothing that depends on the directory a command happens to run from (CV-G1-020). The
 * Vault used to fall back to `process.cwd()`, so `vault list` in any repository indexed that
 * repository's CLAUDE.md and friends, and the constructor dropped an explicit `projectRoot` on
 * the floor.
 *
 * Every directory below is a realpath: macOS reports `process.cwd()` through /private, and a
 * prefix check against an unresolved temp path would pass for the wrong reason.
 */

const ORIGINAL_CWD = process.cwd();
/** Files `writeProjectConfigs` creates (relative, '/'-separated), and so what a scan of it yields. */
const PROJECT_FILES = [
  '.aider.conf.yml',
  '.claude/local-rule.md',
  '.cursor/rules/style.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.windsurf/rules/flow.md',
  '.windsurfrules',
  'CLAUDE.md',
] as const;
const PROJECT_FILE_COUNT = PROJECT_FILES.length;

interface VaultInternals {
  pendingChanges: Map<string, Set<string>>;
  flushPendingChanges(): Promise<void>;
}

let root: string;
let fakeHome: string;
let claudeDir: string;
let projectDir: string;
let runDir: string;
let vault: Vault | null;

async function writeFileIn(dir: string, relativePath: string, body: string): Promise<string> {
  const filePath = join(dir, ...relativePath.split('/'));
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, body);
  return filePath;
}

/** Every file kind the project-level detection reads, so a leak of any one of them shows. */
async function writeProjectConfigs(dir: string, marker: string): Promise<void> {
  await Promise.all([
    writeFileIn(dir, 'CLAUDE.md', `# ${marker} CLAUDE\nproject instructions\n`),
    writeFileIn(dir, '.claude/local-rule.md', `---\nname: ${marker}-local\n---\nlocal rule body\n`),
    writeFileIn(dir, '.cursorrules', `# ${marker} cursor\n`),
    writeFileIn(dir, '.cursor/rules/style.md', `# ${marker} style\n`),
    writeFileIn(dir, '.github/copilot-instructions.md', `# ${marker} copilot\n`),
    writeFileIn(dir, '.windsurfrules', `# ${marker} windsurf\n`),
    writeFileIn(dir, '.windsurf/rules/flow.md', `# ${marker} flow\n`),
    writeFileIn(dir, '.aider.conf.yml', `# ${marker} aider\nmodel: gpt-4\n`),
  ]);
}

async function writeHomeConfigs(home: string): Promise<void> {
  await Promise.all([
    writeFileIn(home, '.aider.conf.yml', '# home aider\nmodel: sonnet\n'),
    writeFileIn(home, '.continue/config.json', JSON.stringify({ description: 'home continue' })),
  ]);
}

function open(config: Parameters<typeof createVault>[0] = {}): Vault {
  vault = createVault({
    claudeConfigPath: claudeDir,
    dbPath: join(root, 'vault.db'),
    enableWatcher: false,
    defaultSearchTier: 'minisearch',
    ...config,
  });
  return vault;
}

function isUnder(dir: string, filePath: string): boolean {
  return filePath.startsWith(dir + sep);
}

function entriesUnder(v: Vault, dir: string): VaultEntry[] {
  return v.getAllEntries().filter((e) => isUnder(dir, e.filePath));
}

function entryIds(v: Vault): string[] {
  return v.getAllEntries().map((e) => e.id);
}

/** The sparse Claude directory above makes the other parsers report missing folders; ignore them. */
function agentConfigErrors(v: Vault): ParseError[] {
  return v.getErrors().filter((e) => e.parser === 'agent-configs');
}

function errorsFor(v: Vault, filePath: string): ParseError[] {
  return v.getErrors().filter((e) => e.filePath === filePath);
}

/** What the watcher does after two rule files change: one full re-read of the rule parser. */
async function flushRuleChanges(v: Vault, changed: readonly string[]): Promise<void> {
  const internals = v as unknown as VaultInternals;
  internals.pendingChanges.set('rule', new Set(changed));
  await internals.flushPendingChanges();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cv-project-scan-')));
  fakeHome = join(root, 'home');
  claudeDir = join(root, 'claude');
  projectDir = join(root, 'project');
  runDir = join(root, 'run-here');
  await Promise.all([
    mkdir(fakeHome, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(runDir, { recursive: true }),
    writeFileIn(
      claudeDir,
      'skills/one/SKILL.md',
      '---\nname: one\ndescription: first\n---\nBody.\n',
    ),
  ]);
  await Promise.all([
    writeProjectConfigs(projectDir, 'explicit'),
    writeProjectConfigs(runDir, 'cwd'),
  ]);
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('COMMANDVAULT_HOME', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  process.chdir(runDir);
  vault = null;
});

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  await vault?.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Vault without a projectRoot', () => {
  it('indexes nothing from the current directory', async () => {
    const v = open();

    await v.initialize();

    expect(entriesUnder(v, runDir)).toEqual([]);
    expect(v.getAllEntries().map((e) => e.name)).toEqual(['one']);
    expect(agentConfigErrors(v)).toEqual([]);
  });

  it('stays out of the current directory on a rescan and from any other directory', async () => {
    const v = open();
    await v.initialize();

    process.chdir(projectDir);
    await v.scan();

    expect(entriesUnder(v, projectDir)).toEqual([]);
    expect(entriesUnder(v, runDir)).toEqual([]);
    expect(v.getAllEntries().map((e) => e.name)).toEqual(['one']);
  });

  it('still indexes the account-level agent configs under the home directory', async () => {
    await writeHomeConfigs(fakeHome);
    const v = open();

    await v.initialize();

    const home = v.getAllEntries().filter((e) => isUnder(fakeHome, e.filePath));
    expect(home.map((e) => e.source).sort()).toEqual(['aider', 'continue']);
    expect(home.map((e) => e.filePath).sort()).toEqual([
      join(fakeHome, '.aider.conf.yml'),
      join(fakeHome, '.continue', 'config.json'),
    ]);
    expect(entriesUnder(v, runDir)).toEqual([]);
  });

  it('reads the home directory when it scans, not when the vault was created', async () => {
    const laterHome = join(root, 'later-home');
    await writeHomeConfigs(laterHome);
    const v = open();

    vi.stubEnv('HOME', laterHome);
    vi.stubEnv('USERPROFILE', laterHome);
    await v.initialize();

    expect(v.getEntriesBySource('aider').map((e) => e.filePath)).toEqual([
      join(laterHome, '.aider.conf.yml'),
    ]);
  });
});

describe('Vault with a projectRoot', () => {
  it('scans exactly that directory and not the current one', async () => {
    const v = open({ projectRoot: projectDir });

    await v.initialize();

    const expected = PROJECT_FILES.map((name) => join(projectDir, ...name.split('/')));
    expect(
      entriesUnder(v, projectDir)
        .map((e) => e.filePath)
        .sort(),
    ).toEqual(expected.sort());
    expect(entriesUnder(v, runDir)).toEqual([]);
    expect(agentConfigErrors(v)).toEqual([]);
  });

  it('resolves a relative directory against the current directory when the vault is created', async () => {
    process.chdir(root);
    const v = open({ projectRoot: 'project' });
    process.chdir(runDir);

    await v.initialize();

    expect(entriesUnder(v, projectDir)).toHaveLength(PROJECT_FILE_COUNT);
    expect(entriesUnder(v, runDir)).toEqual([]);
  });

  it('also keeps the Claude directory and home-level configs', async () => {
    await writeHomeConfigs(fakeHome);
    const v = open({ projectRoot: projectDir });

    await v.initialize();

    expect(v.getEntriesByType('skill').map((e) => e.name)).toEqual(['one']);
    expect(v.getEntriesBySource('continue')).toHaveLength(1);
    expect(v.getEntriesBySource('aider').map((e) => e.filePath)).toContain(
      join(fakeHome, '.aider.conf.yml'),
    );
  });
});

describe('Vault with a projectRoot that cannot be scanned', () => {
  it('reports a directory that does not exist as an error, not as an empty scan', async () => {
    const missing = join(root, 'no-such-dir');
    const v = open({ projectRoot: missing });
    const emitted: ParseError[] = [];
    v.on('error', (err) => emitted.push(err));

    await expect(v.initialize()).resolves.toBeDefined();

    const [problem, ...others] = errorsFor(v, missing);
    expect(others).toEqual([]);
    expect(problem?.severity).toBe('error');
    expect(problem?.message).toContain('does not exist');
    expect(problem?.message).toContain(missing);
    expect(emitted).toContainEqual(problem);
    expect(entriesUnder(v, runDir)).toEqual([]);
    expect(v.getEntriesByType('skill').map((e) => e.name)).toEqual(['one']);
  });

  it('reports a file given instead of a directory', async () => {
    const notADirectory = await writeFileIn(root, 'plain-file.txt', 'not a directory');
    const v = open({ projectRoot: notADirectory });

    await v.initialize();

    const [problem] = errorsFor(v, notADirectory);
    expect(problem?.severity).toBe('error');
    expect(problem?.message).toContain('not a directory');
    expect(entriesUnder(v, runDir)).toEqual([]);
  });

  it.each(['', '   '])('does not read %j as the current directory', async (blank) => {
    const v = open({ projectRoot: blank });

    await v.initialize();

    expect(entriesUnder(v, runDir)).toEqual([]);
    const problems = agentConfigErrors(v);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('error');
    expect(problems[0]?.message).toContain('empty');
  });

  it('still indexes the account-level agent configs', async () => {
    await writeHomeConfigs(fakeHome);
    const v = open({ projectRoot: join(root, 'no-such-dir') });

    await v.initialize();

    expect(v.getEntriesBySource('continue')).toHaveLength(1);
    expect(v.getEntriesBySource('aider')).toHaveLength(1);
  });
});

describe('Vault re-reading rules keeps project scanning consistent', () => {
  it('scanSingle("rule") keeps the project entries of an explicit root', async () => {
    await writeFileIn(claudeDir, 'rules/claude-rule.md', '---\nname: claude-rule\n---\nBody.\n');
    const v = open({ projectRoot: projectDir });
    await v.initialize();
    const before = entryIds(v).sort();

    await v.scanSingle('rule');

    expect(entryIds(v).sort()).toEqual(before);
    expect(entriesUnder(v, projectDir)).toHaveLength(PROJECT_FILE_COUNT);
    expect(v.getEntriesByType('rule').map((e) => e.name)).toContain('claude-rule');
  });

  it('scanSingle("rule") adds no project entries when there is no root', async () => {
    await writeHomeConfigs(fakeHome);
    const v = open();
    await v.initialize();
    const before = entryIds(v).sort();

    await v.scanSingle('rule');

    expect(entryIds(v).sort()).toEqual(before);
    expect(entriesUnder(v, runDir)).toEqual([]);
    expect(v.getEntriesBySource('continue')).toHaveLength(1);
  });

  it('a watcher flush that re-reads rules keeps the project entries', async () => {
    const first = await writeFileIn(claudeDir, 'rules/one.md', '---\nname: rule-one\n---\nA.\n');
    const second = await writeFileIn(claudeDir, 'rules/two.md', '---\nname: rule-two\n---\nB.\n');
    const v = open({ projectRoot: projectDir });
    await v.initialize();
    const internals = v as unknown as VaultInternals;

    internals.pendingChanges.set('rule', new Set([first, second]));
    await internals.flushPendingChanges();

    expect(entriesUnder(v, projectDir)).toHaveLength(PROJECT_FILE_COUNT);
    expect(v.getEntriesByType('rule').map((e) => e.name)).toEqual(
      expect.arrayContaining(['rule-one', 'rule-two']),
    );
  });

  it('a watcher flush that re-reads rules adds no project entries when there is no root', async () => {
    const first = await writeFileIn(claudeDir, 'rules/one.md', '---\nname: rule-one\n---\nA.\n');
    const second = await writeFileIn(claudeDir, 'rules/two.md', '---\nname: rule-two\n---\nB.\n');
    const v = open();
    await v.initialize();
    const internals = v as unknown as VaultInternals;

    internals.pendingChanges.set('rule', new Set([first, second]));
    await internals.flushPendingChanges();

    expect(entriesUnder(v, runDir)).toEqual([]);
  });

  it('does not pile up the project-root error when rules are re-read', async () => {
    const missing = join(root, 'no-such-dir');
    const v = open({ projectRoot: missing });
    await v.initialize();

    await v.scanSingle('rule');
    await v.scanSingle('rule');

    expect(errorsFor(v, missing)).toHaveLength(1);
  });

  it('leaves the project entries alone when another type is re-read', async () => {
    const v = open({ projectRoot: projectDir });
    await v.initialize();

    await v.scanSingle('skill');

    expect(entriesUnder(v, projectDir)).toHaveLength(PROJECT_FILE_COUNT);
  });
});

describe('A watcher flush that re-reads rules replaces the agent-config errors', () => {
  // The flush path keeps its own copy of the "which errors does this parser own" rule. The
  // agent-config detection is part of the rule parser, so its errors are the rule parser's to
  // replace. Without that, every flush adds another copy of the same problem.
  async function twoRuleFiles(): Promise<string[]> {
    return Promise.all([
      writeFileIn(claudeDir, 'rules/one.md', '---\nname: rule-one\n---\nA.\n'),
      writeFileIn(claudeDir, 'rules/two.md', '---\nname: rule-two\n---\nB.\n'),
    ]);
  }

  it('does not pile up the project-root error', async () => {
    const changed = await twoRuleFiles();
    const missing = join(root, 'no-such-dir');
    const v = open({ projectRoot: missing });
    await v.initialize();

    await flushRuleChanges(v, changed);
    await flushRuleChanges(v, changed);

    expect(errorsFor(v, missing)).toHaveLength(1);
    expect(agentConfigErrors(v)).toHaveLength(1);
  });

  it('drops the project-root error once the directory exists', async () => {
    const changed = await twoRuleFiles();
    const later = join(root, 'later-project');
    const v = open({ projectRoot: later });
    await v.initialize();
    expect(errorsFor(v, later)).toHaveLength(1);
    await mkdir(later, { recursive: true });
    await writeProjectConfigs(later, 'later');

    await flushRuleChanges(v, changed);

    expect(errorsFor(v, later)).toEqual([]);
    expect(entriesUnder(v, later)).toHaveLength(PROJECT_FILE_COUNT);
  });

  it('keeps the errors of the parsers it did not re-read', async () => {
    const changed = await twoRuleFiles();
    const v = open({ projectRoot: join(root, 'no-such-dir') });
    await v.initialize();
    const others = v.getErrors().filter((e) => e.parser !== 'agent-configs');
    expect(others.length).toBeGreaterThan(0);

    await flushRuleChanges(v, changed);

    expect(v.getErrors().filter((e) => e.parser !== 'agent-configs')).toEqual(others);
  });
});
