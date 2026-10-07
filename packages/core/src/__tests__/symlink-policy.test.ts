import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgents } from '../parsers/agent-parser.js';
import { parseSkills } from '../parsers/skill-parser.js';
import { parseSingleFile } from '../parsers/single-file-parser.js';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';
import type { ParseError, VaultEntry } from '../types/index.js';

/**
 * Two symlink policies. Inside the Claude configuration directory links are the user's own
 * (skills linked from a shared repository), so a link to a regular file is followed and recorded
 * (`metadata.linkTarget`, tag `symlink`); a linked skill folder is followed and not recorded. Under
 * `--project` the directory is untrusted: a file whose real path leaves the project root (a
 * `CLAUDE.md` pointing at `~/.ssh`) is skipped with a warning and nothing of it is indexed.
 */

const IS_WINDOWS = process.platform === 'win32';
const HANG_BUDGET_MS = 2000;
const OUTSIDE_MARKER = 'OUTSIDEMARKER-7f3c1e-must-never-be-indexed';

function markdown(name: string, body = `Body of ${name}.`): string {
  return `---\nname: ${name}\ndescription: Describes ${name}\n---\n${body}\n`;
}

async function writeIn(dir: string, relative: string, text: string): Promise<string> {
  const path = join(dir, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  return path;
}

function expectWarning(errors: readonly ParseError[], filePath: string, pattern: RegExp): void {
  const matching = errors.filter((e) => e.filePath === filePath);
  expect(matching).toHaveLength(1);
  expect(getParseSeverity(matching[0])).toBe('warning');
  expect(matching[0].message).toMatch(pattern);
}

function expectLinkFields(entry: VaultEntry | undefined, target: string): void {
  expect(entry).toBeDefined();
  expect(entry!.metadata.linkTarget).toBe(target);
  expect(entry!.tags).toContain('symlink');
}

function expectNoLinkFields(entry: VaultEntry | undefined): void {
  expect(entry).toBeDefined();
  expect(entry!.metadata).not.toHaveProperty('linkTarget');
  expect(entry!.tags).not.toContain('symlink');
}

let tempDir: string;
let claudeDir: string;
let outsideDir: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-symlink-policy-')));
  claudeDir = join(tempDir, 'claude');
  outsideDir = join(tempDir, 'outside');
  await mkdir(claudeDir);
  await mkdir(outsideDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS)(
  'symlinks inside the Claude directory are followed and recorded',
  () => {
    it('indexes a file link whose target is elsewhere in the directory, with linkTarget and tag', async () => {
      const target = await writeIn(claudeDir, 'extra/inside-agent.md', markdown('inside-agent'));
      await mkdir(join(claudeDir, 'agents'));
      const linkPath = join(claudeDir, 'agents', 'inside.md');
      await symlink(join('..', 'extra', 'inside-agent.md'), linkPath);

      const result = await parseAgents(join(claudeDir, 'agents'));

      expect(result.errors).toEqual([]);
      const entry = result.entries.find((e) => e.filePath === linkPath);
      expectLinkFields(entry, target);
      expect(entry!.name).toBe('inside-agent');
    });

    it('indexes a file link whose target is outside the directory the same way', async () => {
      const target = await writeIn(outsideDir, 'outside-agent.md', markdown('outside-agent'));
      await mkdir(join(claudeDir, 'agents'));
      const linkPath = join(claudeDir, 'agents', 'outside.md');
      await symlink(target, linkPath);

      const result = await parseAgents(join(claudeDir, 'agents'));

      expect(result.errors).toEqual([]);
      expectLinkFields(
        result.entries.find((e) => e.filePath === linkPath),
        target,
      );
    });

    it('follows a linked skill directory without recording a link', async () => {
      await writeIn(outsideDir, 'linked-skill/SKILL.md', markdown('linked-skill'));
      await mkdir(join(claudeDir, 'skills'));
      await symlink(join(outsideDir, 'linked-skill'), join(claudeDir, 'skills', 'linked'), 'dir');

      const result = await parseSkills(join(claudeDir, 'skills'));

      expect(result.errors).toEqual([]);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('linked-skill');
      expectNoLinkFields(result.entries[0]);
    });

    it(
      'reports a two-link loop with one warning per link and no hang',
      async () => {
        const agentsDir = join(claudeDir, 'agents');
        await mkdir(agentsDir);
        await writeIn(agentsDir, 'ok.md', markdown('ok'));
        const linkA = join(agentsDir, 'loop-a.md');
        const linkB = join(agentsDir, 'loop-b.md');
        await symlink('loop-b.md', linkA);
        await symlink('loop-a.md', linkB);

        const result = await parseAgents(agentsDir);

        expect(result.entries.map((e) => e.name)).toEqual(['ok']);
        expect(result.errors).toHaveLength(2);
        expectWarning(result.errors, linkA, /symlink .*cannot be resolved/);
        expectWarning(result.errors, linkB, /symlink .*cannot be resolved/);
      },
      HANG_BUDGET_MS,
    );

    it('the watcher single-file path records the same two fields', async () => {
      const target = await writeIn(claudeDir, 'extra/watched.md', markdown('watched'));
      await mkdir(join(claudeDir, 'agents'));
      const linkPath = join(claudeDir, 'agents', 'watched.md');
      await symlink(target, linkPath);

      const entry = await parseSingleFile(linkPath, 'agent');

      expectLinkFields(entry ?? undefined, target);
      expect(entry!.filePath).toBe(linkPath);
    });

    it('gives a regular file neither field', async () => {
      const agentsDir = join(claudeDir, 'agents');
      const plainPath = await writeIn(agentsDir, 'plain.md', markdown('plain'));

      const result = await parseAgents(agentsDir);
      const single = await parseSingleFile(plainPath, 'agent');

      expectNoLinkFields(result.entries[0]);
      expectNoLinkFields(single ?? undefined);
    });
  },
);

describe.skipIf(IS_WINDOWS)('symlinks under --project are contained in the project root', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = join(tempDir, 'project');
    await mkdir(projectRoot);
    await writeIn(outsideDir, 'secret.md', `# Secret\n${OUTSIDE_MARKER}\n`);
  });

  function indexedText(entries: readonly VaultEntry[]): string {
    return JSON.stringify(entries);
  }

  it('skips a CLAUDE.md that links outside the project, with a warning naming the link', async () => {
    const linkPath = join(projectRoot, 'CLAUDE.md');
    await symlink(join(outsideDir, 'secret.md'), linkPath);

    const result = await detectAgentConfigs(projectRoot);

    expect(indexedText(result.entries)).not.toContain(OUTSIDE_MARKER);
    expect(result.entries.find((e) => e.filePath === linkPath)).toBeUndefined();
    expectWarning(result.errors, linkPath, /outside the project directory/);
  });

  it('skips a .cursor/rules file that links outside the project', async () => {
    const linkPath = join(projectRoot, '.cursor', 'rules', 'x.mdc');
    await mkdir(join(projectRoot, '.cursor', 'rules'), { recursive: true });
    await symlink(join(outsideDir, 'secret.md'), linkPath);

    const result = await detectAgentConfigs(projectRoot);

    expect(indexedText(result.entries)).not.toContain(OUTSIDE_MARKER);
    expectWarning(result.errors, linkPath, /outside the project directory/);
  });

  it('indexes a .claude file that links inside the project, recording the target', async () => {
    const target = await writeIn(projectRoot, 'docs/guide.md', markdown('guide'));
    const linkPath = join(projectRoot, '.claude', 'y.md');
    await mkdir(join(projectRoot, '.claude'));
    await symlink(target, linkPath);

    const result = await detectAgentConfigs(projectRoot);

    expect(result.errors).toEqual([]);
    expectLinkFields(
      result.entries.find((e) => e.filePath === linkPath),
      target,
    );
  });

  it('indexes a regular file reached through a linked project root', async () => {
    const filePath = await writeIn(projectRoot, 'CLAUDE.md', '# Project\nReal file.\n');
    const rootLink = join(tempDir, 'project-link');
    await symlink(projectRoot, rootLink, 'dir');

    const result = await detectAgentConfigs(rootLink);

    expect(result.errors).toEqual([]);
    const entry = result.entries.find((e) => e.filePath === join(rootLink, 'CLAUDE.md'));
    expectNoLinkFields(entry);
    expect(entry!.content).toContain('Real file.');
    expect(filePath).toBe(join(projectRoot, 'CLAUDE.md'));
  });

  it('skips a dangling link with a warning', async () => {
    const linkPath = join(projectRoot, '.cursor', 'rules', 'dangling.mdc');
    await mkdir(join(projectRoot, '.cursor', 'rules'), { recursive: true });
    await symlink(join(outsideDir, 'missing.md'), linkPath);

    const result = await detectAgentConfigs(projectRoot);

    expect(result.entries).toEqual([]);
    expectWarning(result.errors, linkPath, /symlink .*cannot be resolved/);
  });
});

/**
 * `hops` links in a row: `head` is the first, the intermediate ones live in `hopsDir`, the last
 * points at `target`.
 */
async function linkChain(
  head: string,
  hopsDir: string,
  hops: number,
  target: string,
): Promise<void> {
  let next = target;
  for (let hop = hops - 1; hop >= 1; hop -= 1) {
    const hopPath = join(hopsDir, `hop${hop}.md`);
    await symlink(next, hopPath);
    next = hopPath;
  }
  await symlink(next, head);
}

const MAX_PROBED_HOPS = 64;

/**
 * The shortest chain whose head realpath resolves while stat refuses it, or null when the two
 * limits agree. realpath(3) follows one link more than stat(2) does (33 against 32 on macOS, for
 * a path with no other links in it); a platform with one limit for both has nothing to test here.
 */
async function hopsLibcResolvesButKernelRefuses(probeDir: string): Promise<number | null> {
  const target = await writeIn(probeDir, 'real.md', markdown('real'));
  for (let hops = 2; hops <= MAX_PROBED_HOPS; hops += 1) {
    const dir = join(probeDir, `chain-${hops}`);
    await mkdir(dir);
    const head = join(dir, 'head.md');
    await linkChain(head, dir, hops, target);
    const resolves = await realpath(head).then(
      () => true,
      () => false,
    );
    const stats = await stat(head).then(
      () => true,
      () => false,
    );
    if (resolves && !stats) return hops;
    if (!resolves) return null;
  }
  return null;
}

describe.skipIf(IS_WINDOWS)('a link chain libc resolves and the kernel refuses to stat', () => {
  // Such a file is read through its real path; its lastModified must come from that path too, or
  // the file is read and then rejected with a plain ELOOP error instead of being indexed.
  let probeDir: string;
  let hops: number | null = null;

  beforeAll(async () => {
    probeDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-link-chain-')));
    hops = await hopsLibcResolvesButKernelRefuses(probeDir);
  });

  afterAll(async () => {
    await rm(probeDir, { recursive: true, force: true });
  });

  function hopsOrSkip(skip: (note?: string) => never): number {
    if (hops === null) skip('realpath and stat follow the same number of links on this platform');
    return hops as number;
  }

  it('indexes an agent file at the end of such a chain, dated by the file it read', async ({
    skip,
  }) => {
    const chain = hopsOrSkip(skip);
    const agentsDir = join(claudeDir, 'agents');
    await mkdir(agentsDir);
    const hopsDir = join(claudeDir, 'hops');
    await mkdir(hopsDir);
    const target = await writeIn(claudeDir, 'extra/chained.md', markdown('chained'));
    const head = join(agentsDir, 'chained.md');
    await linkChain(head, hopsDir, chain, target);

    const result = await parseAgents(agentsDir);

    expect(result.errors).toEqual([]);
    const entry = result.entries.find((e) => e.filePath === head);
    expectLinkFields(entry, target);
    expect(entry!.lastModified).toEqual((await stat(target)).mtime);
  });

  it('the watcher single-file path yields the same entry', async ({ skip }) => {
    const chain = hopsOrSkip(skip);
    const hopsDir = join(claudeDir, 'hops');
    await mkdir(hopsDir);
    const target = await writeIn(claudeDir, 'extra/watched.md', markdown('watched'));
    const head = join(claudeDir, 'agents', 'watched.md');
    await mkdir(join(claudeDir, 'agents'));
    await linkChain(head, hopsDir, chain, target);

    const entry = await parseSingleFile(head, 'agent');

    expectLinkFields(entry ?? undefined, target);
    expect(entry!.lastModified).toEqual((await stat(target)).mtime);
  });

  it('indexes a .claude rule reached through such a chain inside the project', async ({ skip }) => {
    const chain = hopsOrSkip(skip);
    const projectRoot = join(tempDir, 'project');
    const hopsDir = join(projectRoot, 'hops');
    await mkdir(hopsDir, { recursive: true });
    await mkdir(join(projectRoot, '.claude'));
    const target = await writeIn(projectRoot, 'docs/guide.md', markdown('guide'));
    const head = join(projectRoot, '.claude', 'guide.md');
    await linkChain(head, hopsDir, chain, target);

    const result = await detectAgentConfigs(projectRoot);

    expect(result.errors).toEqual([]);
    expectLinkFields(
      result.entries.find((e) => e.filePath === head),
      target,
    );
  });

  it('indexes a project CLAUDE.md reached through such a chain', async ({ skip }) => {
    const chain = hopsOrSkip(skip);
    const projectRoot = join(tempDir, 'project');
    const hopsDir = join(projectRoot, 'hops');
    await mkdir(hopsDir, { recursive: true });
    const target = await writeIn(projectRoot, 'docs/claude.md', '# Project\nReal file.\n');
    const head = join(projectRoot, 'CLAUDE.md');
    await linkChain(head, hopsDir, chain, target);

    const result = await detectAgentConfigs(projectRoot);

    expect(result.errors).toEqual([]);
    const entry = result.entries.find((e) => e.filePath === head);
    expectLinkFields(entry, target);
    expect(entry!.content).toContain('Real file.');
  });
});
