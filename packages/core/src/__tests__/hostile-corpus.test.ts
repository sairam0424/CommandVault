import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Vault, createVault } from '../vault.js';
import { getParseSeverity } from '../scan-pipeline.js';
import {
  BENIGN_ALIAS_LOOKALIKES,
  OUTSIDE_MARKER,
  buildHostileClaudeDir,
  buildHostileProject,
  expectedCounts,
  removeHostileDir,
} from './hostile-claude-dir.js';

/**
 * One full scan over every hostile file shape at once, through the Vault (parsers, pipeline and
 * index together): it completes, costs bounded time and memory, indexes exactly the benign and
 * recovered entries, reports exactly one warning per hostile shape, and never stores anything
 * from outside the project directory.
 */

const IS_WINDOWS = process.platform === 'win32';
const TIME_BUDGET_MS = 5000;
const RSS_BUDGET_BYTES = 300 * 1024 * 1024;
// process.resourceUsage().maxRSS is in KiB on every platform (libuv normalises Darwin's bytes).
const KIB = 1024;

/** The process's peak resident set so far, in bytes. */
function peakRss(): number {
  return process.resourceUsage().maxRSS * KIB;
}

describe.skipIf(IS_WINDOWS)('Vault over the hostile corpus', () => {
  let workDir: string;
  let claudeDir: string;
  let projectDir: string;
  let vault: Vault;
  let elapsedMs = 0;
  let rssDelta = 0;
  let peakRssDelta = 0;

  beforeAll(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-hostile-')));
    claudeDir = join(workDir, 'claude');
    projectDir = join(workDir, 'project');
    await buildHostileClaudeDir(claudeDir);
    await buildHostileProject(projectDir);

    const rssBefore = process.memoryUsage().rss;
    const peakBefore = peakRss();
    const started = performance.now();
    vault = createVault({
      claudeConfigPath: claudeDir,
      dbPath: join(workDir, 'vault.db'),
      enableWatcher: false,
      defaultSearchTier: 'minisearch',
      projectRoot: projectDir,
    });
    await vault.initialize();
    elapsedMs = performance.now() - started;
    rssDelta = process.memoryUsage().rss - rssBefore;
    // The resident set at the end misses a transient V8 already gave back (splitting a 32 MiB
    // block into 32 million lines was over 1 GiB for well under a second); the peak keeps it.
    // Peak to peak, so an earlier, higher peak of this worker can only hide, never inflate.
    peakRssDelta = peakRss() - peakBefore;
  });

  afterAll(async () => {
    await vault.dispose();
    await removeHostileDir(claudeDir);
    await removeHostileDir(projectDir);
    await rm(workDir, { recursive: true, force: true });
  });

  it('indexes exactly the benign and recovered entries', () => {
    expect(vault.getAllEntries()).toHaveLength(expectedCounts().entries);
  });

  it('reports one warning per hostile shape and no errors', () => {
    const problems = vault.getErrors();
    const errors = problems.filter((p) => getParseSeverity(p) === 'error');
    const warnings = problems.filter((p) => getParseSeverity(p) === 'warning');

    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(expectedCounts().warnings);
  });

  it('stores nothing from outside the project directory', () => {
    expect(JSON.stringify(vault.getAllEntries())).not.toContain(OUTSIDE_MARKER);
    expect(JSON.stringify(vault.getErrors())).not.toContain(OUTSIDE_MARKER);
  });

  // Counts cannot tell the guard from the sanitizer backstop: a bomb that reaches YAML is still one
  // entry and one warning, 'frontmatter truncated' instead of 'frontmatter skipped: aliases'.
  it('skips every alias bomb before YAML runs, whichever opener it hides behind', () => {
    const skipped = vault
      .getErrors()
      .filter((p) => /frontmatter skipped: aliases/.test(p.message))
      .map((p) => basename(dirname(p.filePath)))
      .sort();

    expect(skipped).toEqual([
      'laughs',
      'laughs-flow',
      'laughs-flow-spaced',
      'laughs-nbsp',
      'laughs-tagged',
      'laughs-upper',
      'laughs-yaml',
    ]);
  });

  // 70 KiB of value, 65 400 blank lines under the byte cap, line breaks followed by a long run of
  // spaces under the line cap, and a 32 MiB file of newlines: each is indexed under its name after
  // the guard, with one oversize warning and nothing else.
  it.each(['big-frontmatter', 'blank-lines', 'padded', 'huge-blank'])(
    'skips the oversize block of %s before YAML runs and still indexes it under its name',
    (name) => {
      const entry = vault.getAllEntries().find((e) => e.name === name);
      expect(entry?.metadata.frontmatterRecovery).toBe('line-based');
      const messages = vault
        .getErrors()
        .filter((p) => p.filePath === entry!.filePath)
        .map((p) => p.message);
      expect(messages).toEqual([expect.stringMatching(/frontmatter skipped: oversize/)]);
    },
  );

  it.each(BENIGN_ALIAS_LOOKALIKES.map((skill) => skill.name))(
    'keeps the whole frontmatter of %s, whose values only look like anchors and aliases',
    (name) => {
      const entry = vault.getAllEntries().find((e) => e.name === name);
      expect(entry).toBeDefined();
      expect(entry!.metadata.allowedTools).toEqual(['Bash', 'Read']);
      expect(entry!.metadata.triggers).toEqual(['lint', 'format']);
      expect(entry!.metadata.frontmatterRecovery).toBeUndefined();
      expect(entry!.tags).not.toContain('frontmatter-warning');
      expect(vault.getErrors().filter((p) => p.filePath === entry!.filePath)).toEqual([]);
    },
  );

  it('keeps every entry serialisable', () => {
    for (const entry of vault.getAllEntries()) {
      expect(() => JSON.stringify(entry.metadata)).not.toThrow();
    }
  });

  it('records the symlink targets it followed and only those', () => {
    const linked = vault.getAllEntries().filter((e) => e.tags.includes('symlink'));

    expect(linked.map((e) => e.name).sort()).toEqual(['guide', 'inside-agent', 'outside-rule']);
    for (const entry of linked) expect(typeof entry.metadata.linkTarget).toBe('string');
  });

  // Three budgets, one case each, so a run that breaks one still reports the other two.
  it('finishes inside the time budget', () => {
    expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
  });

  it('ends inside the memory budget', () => {
    expect(rssDelta).toBeLessThan(RSS_BUDGET_BYTES);
  });

  it('peaks inside the memory budget', () => {
    expect(peakRssDelta).toBeLessThan(RSS_BUDGET_BYTES);
  });
});
