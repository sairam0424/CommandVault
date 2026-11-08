import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Under `--project` the directory is untrusted, so a file whose real path leaves the project is
 * skipped. The check resolves the path and the read opens it a moment later: a writer that swaps
 * the file (or one of its directories) for a link inside that gap must not get an outside file
 * indexed. These tests make the gap deterministic: the mocked `open` runs a swap just before, and
 * optionally just after, the real open of one named path, which is where a concurrent writer would
 * strike. A static link outside the project is covered by symlink-policy.test.ts.
 */

interface Swap {
  /** The exact path the reader opens. */
  readonly path: string;
  readonly beforeOpen?: () => Promise<void>;
  readonly afterOpen?: () => Promise<void>;
}

const race = vi.hoisted(() => ({ swap: null as Swap | null, fired: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const swap = race.swap;
    if (swap === null || String(args[0]) !== swap.path) return actual.open(...args);
    race.swap = null;
    race.fired += 1;
    await swap.beforeOpen?.();
    const handle = await actual.open(...args);
    await swap.afterOpen?.();
    return handle;
  });
  return { ...actual, open };
});

import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { parseHooks } from '../parsers/hook-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';

const IS_WINDOWS = process.platform === 'win32';
const OUTSIDE_MARKER = 'OUTSIDEMARKER-9b2d4f-must-never-be-indexed';
const INSIDE_TEXT = '# Project\nThe project own instructions.\n';

let tempDir: string;
let projectRoot: string;
let outsideDir: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-containment-race-')));
  projectRoot = join(tempDir, 'project');
  outsideDir = join(tempDir, 'outside');
  await mkdir(projectRoot);
  await mkdir(join(outsideDir, 'rules'), { recursive: true });
  await writeFile(join(outsideDir, 'secret.md'), `# Secret\n${OUTSIDE_MARKER}\n`);
  await writeFile(join(outsideDir, 'rules', 'x.mdc'), `# Secret rule\n${OUTSIDE_MARKER}\n`);
  race.swap = null;
  race.fired = 0;
});

afterEach(async () => {
  race.swap = null;
  await rm(tempDir, { recursive: true, force: true });
});

/** Replaces `path` with a link to `target`, the way an atomic swap does: rename, then link. */
async function replaceWithLink(path: string, target: string, type?: 'dir'): Promise<void> {
  await rename(path, `${path}.orig`);
  await symlink(target, path, type);
}

async function restoreOriginal(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await rename(`${path}.orig`, path);
}

function expectSkippedNotIndexed(
  result: Awaited<ReturnType<typeof detectAgentConfigs>>,
  filePath: string,
): void {
  expect(JSON.stringify(result.entries)).not.toContain(OUTSIDE_MARKER);
  expect(result.entries.find((entry) => entry.filePath === filePath)).toBeUndefined();
  const warnings = result.errors.filter((error) => error.filePath === filePath);
  expect(warnings).toHaveLength(1);
  expect(getParseSeverity(warnings[0])).toBe('warning');
}

describe.skipIf(IS_WINDOWS)('a project file swapped for a link while it is being opened', () => {
  it('indexes the project file when nothing is swapped, through the same open', async () => {
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    await writeFile(claudeMd, INSIDE_TEXT);
    race.swap = { path: claudeMd, beforeOpen: async () => undefined };

    const result = await detectAgentConfigs(projectRoot);

    expect(race.fired).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.entries.find((entry) => entry.filePath === claudeMd)?.content).toContain(
      'The project own instructions.',
    );
  });

  it('refuses a file replaced by a link to an outside file just before the open', async () => {
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    await writeFile(claudeMd, INSIDE_TEXT);
    race.swap = {
      path: claudeMd,
      beforeOpen: () => replaceWithLink(claudeMd, join(outsideDir, 'secret.md')),
    };

    const result = await detectAgentConfigs(projectRoot);

    expect(race.fired).toBe(1);
    expectSkippedNotIndexed(result, claudeMd);
  });

  it('refuses a file whose directory was replaced by a link to an outside directory', async () => {
    const rulesDir = join(projectRoot, '.cursor', 'rules');
    const rule = join(rulesDir, 'x.mdc');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(rule, '# Rule\nThe project own rule.\n');
    race.swap = {
      path: rule,
      beforeOpen: () => replaceWithLink(join(projectRoot, '.cursor'), outsideDir, 'dir'),
    };

    const result = await detectAgentConfigs(projectRoot);

    expect(race.fired).toBe(1);
    expectSkippedNotIndexed(result, rule);
  });

  it('refuses a file that was a link only for the moment of the open', async () => {
    // A check that looks at the path again after the open sees an ordinary file once the link is
    // gone: only the file the open actually returned tells the two apart.
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    await writeFile(claudeMd, INSIDE_TEXT);
    race.swap = {
      path: claudeMd,
      beforeOpen: () => replaceWithLink(claudeMd, join(outsideDir, 'secret.md')),
      afterOpen: () => restoreOriginal(claudeMd),
    };

    const result = await detectAgentConfigs(projectRoot);

    expect(race.fired).toBe(1);
    expectSkippedNotIndexed(result, claudeMd);
  });
});

describe.skipIf(IS_WINDOWS)(
  'a project file whose directory is a link only while it is opened',
  () => {
    it('refuses the file the open returned, though the path is ordinary again afterwards', async () => {
      // Every file on the path is a plain file before and after: only the identity of the file the
      // open returned tells the project's own rule from the outside one it landed on.
      const rule = join(projectRoot, '.cursor', 'rules', 'x.mdc');
      await mkdir(join(projectRoot, '.cursor', 'rules'), { recursive: true });
      await writeFile(rule, '# Rule\nThe project own rule.\n');
      race.swap = {
        path: rule,
        beforeOpen: () => replaceWithLink(join(projectRoot, '.cursor'), outsideDir, 'dir'),
        afterOpen: () => restoreOriginal(join(projectRoot, '.cursor')),
      };

      const result = await detectAgentConfigs(projectRoot);

      expect(race.fired).toBe(1);
      expectSkippedNotIndexed(result, rule);
    });
  },
);

describe.skipIf(IS_WINDOWS)('a hook script swapped for a link while it is being opened', () => {
  // The hook parser validates a script against its roots (the project and the settings directory)
  // the same way, then opens it: the same gap, the same confirmation.
  async function writeSettings(script: string): Promise<string> {
    const claudeDir = join(tempDir, 'claude');
    await mkdir(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: `node ${script}` }] }] };
    await writeFile(settingsPath, JSON.stringify({ hooks }));
    return settingsPath;
  }

  it('reads the script when nothing is swapped, through the same open', async () => {
    const script = join(projectRoot, 'hooks', 'guard.js');
    await mkdir(join(projectRoot, 'hooks'));
    await writeFile(script, '// project hook\n');
    race.swap = { path: script, beforeOpen: async () => undefined };

    const result = await parseHooks(await writeSettings(script), { projectRoot });

    expect(race.fired).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.entries[0].content).toBe('// project hook\n');
  });

  it('keeps an outside file out of the entry and warns', async () => {
    const script = join(projectRoot, 'hooks', 'guard.js');
    await mkdir(join(projectRoot, 'hooks'));
    await writeFile(script, '// project hook\n');
    race.swap = {
      path: script,
      beforeOpen: () => replaceWithLink(script, join(outsideDir, 'secret.md')),
    };

    const result = await parseHooks(await writeSettings(script), { projectRoot });

    expect(race.fired).toBe(1);
    expect(JSON.stringify(result.entries)).not.toContain(OUTSIDE_MARKER);
    expect(result.entries).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(getParseSeverity(result.errors[0])).toBe('warning');
    expect(result.errors[0].message).toMatch(/hook script/);
  });
});
