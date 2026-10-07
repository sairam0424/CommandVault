import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `confirmStillInside` judges the handle an open returned with three path checks: the path is its
 * own real path inside the roots, it is a plain file with the opened file's device and inode, and
 * it is its own real path inside the roots again. Each closes a schedule of swaps a writer could
 * otherwise use, so each is pinned here by the shortest schedule that only it refuses. The swaps
 * are made at exact calls (the n-th `realpath`, the n-th `lstat`) of the real file system, which is
 * where a concurrent writer would strike; nothing in the code under test is replaced.
 *
 * What no check can refuse is a writer that swaps a directory above the file in step with all of
 * them (Node has no openat); that residual is documented in link-policy.ts and not asserted here.
 */

interface Hooks {
  /** Calls on paths below this prefix are counted and hooked. */
  prefix: string;
  open: ((call: number) => void) | null;
  realpath: ((call: number) => void) | null;
  lstat: ((call: number) => void) | null;
  /** Report every watched lstat with another device number, as a second file system would. */
  shiftDevice: boolean;
  calls: { open: number; realpath: number; lstat: number };
}

const hooks = vi.hoisted((): Hooks => ({
  prefix: '',
  open: null,
  realpath: null,
  lstat: null,
  shiftDevice: false,
  calls: { open: 0, realpath: 0, lstat: 0 },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const watched = (path: unknown): boolean =>
    hooks.prefix !== '' && typeof path === 'string' && path.startsWith(hooks.prefix);
  const open = vi.fn(async (...args: Parameters<typeof actual.open>) => {
    if (watched(args[0])) {
      hooks.calls.open += 1;
      hooks.open?.(hooks.calls.open);
    }
    return actual.open(...args);
  });
  const realpath = vi.fn(async (...args: Parameters<typeof actual.realpath>) => {
    if (watched(args[0])) {
      hooks.calls.realpath += 1;
      hooks.realpath?.(hooks.calls.realpath);
    }
    return actual.realpath(...args);
  });
  const lstat = vi.fn(async (...args: Parameters<typeof actual.lstat>) => {
    if (watched(args[0])) {
      hooks.calls.lstat += 1;
      hooks.lstat?.(hooks.calls.lstat);
    }
    const stats = await actual.lstat(...args);
    if (!hooks.shiftDevice || !watched(args[0]) || typeof stats.dev !== 'bigint') return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      dev: stats.dev + 1n,
    });
  });
  return { ...actual, open, realpath, lstat } as unknown as typeof actual;
});

import { FileChangedError, readContainedText } from '../parsers/link-policy.js';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';

const IS_WINDOWS = process.platform === 'win32';
const INSIDE = 'INSIDE-BYTES';
const OUTSIDE = 'OUTSIDEMARKER-4e8a1c-must-never-be-read';

let tempDir: string;
let project: string;
let filePath: string;
/** The directory above the file, which a writer swaps between the real one and a link outside. */
let swapped = false;

function directory(): string {
  return join(project, 'dir');
}

function makeLink(): void {
  if (swapped) return;
  renameSync(directory(), join(project, 'dir.real'));
  renameSync(join(project, 'dir.lnk'), directory());
  swapped = true;
}

function makeReal(): void {
  if (!swapped) return;
  renameSync(directory(), join(project, 'dir.lnk'));
  renameSync(join(project, 'dir.real'), directory());
  swapped = false;
}

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'cv-schedules-')));
  project = join(tempDir, 'project');
  const outside = join(tempDir, 'outside');
  mkdirSync(directory(), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(directory(), 'h.txt'), INSIDE);
  writeFileSync(join(outside, 'h.txt'), OUTSIDE);
  symlinkSync(outside, join(project, 'dir.lnk'));
  filePath = join(directory(), 'h.txt');
  swapped = false;
  hooks.prefix = directory();
  hooks.open = null;
  hooks.realpath = null;
  hooks.lstat = null;
  hooks.shiftDevice = false;
  hooks.calls = { open: 0, realpath: 0, lstat: 0 };
});

afterEach(() => {
  hooks.prefix = '';
  makeReal();
  rmSync(tempDir, { recursive: true, force: true });
});

async function readOrRefusal(): Promise<string> {
  try {
    return await readContainedText(filePath, [project]);
  } catch (error) {
    if (error instanceof FileChangedError) return 'refused';
    throw error;
  }
}

describe.skipIf(IS_WINDOWS)('the three checks of confirmStillInside, one schedule each', () => {
  it('reads the file when nothing is swapped, through one open and the three checks', async () => {
    expect(await readOrRefusal()).toBe(INSIDE);

    expect(hooks.calls).toEqual({ open: 1, realpath: 2, lstat: 1 });
  });

  it('refuses a directory that is a link only at the open (one flip)', async () => {
    hooks.open = () => makeLink();

    expect(await readOrRefusal()).toBe('refused');
    expect(hooks.calls.open).toBe(1);
  });

  // The file the open returned is outside; by the first check the directory is real again, so the
  // path is its own real path and only the identity check, whose file is now a different one, sees
  // that the open landed elsewhere. Without the first check, the swap back happens at the check
  // that is now the first one and the identity check has already passed against the link.
  it('refuses a link at the open that is real again by the first check (two flips)', async () => {
    hooks.open = () => makeLink();
    hooks.realpath = (call) => {
      if (call === 1) makeReal();
    };

    expect(await readOrRefusal()).toBe('refused');
    expect(hooks.calls.realpath).toBeGreaterThanOrEqual(1);
  });

  // Link, real, link: the first check and the identity check both pass (the second against the
  // link, which leads to the very file the handle holds). Only the last check, with the link held,
  // sees that the path is not its own real path. Without it the outside bytes are returned.
  it('refuses a link held through the identity check, by the last check (three flips)', async () => {
    hooks.open = () => makeLink();
    hooks.realpath = (call) => {
      if (call === 1) makeReal();
    };
    hooks.lstat = () => makeLink();

    expect(await readOrRefusal()).toBe('refused');
    expect(hooks.calls).toEqual({ open: 1, realpath: 2, lstat: 1 });
  });

  // A file found at the path with the opened file's inode number on another device is another
  // file. Only a second file system can produce the pair, so the device is reported shifted.
  it('refuses a file with the inode of the opened one on another device', async () => {
    hooks.shiftDevice = true;

    expect(await readOrRefusal()).toBe('refused');
  });
});

describe.skipIf(IS_WINDOWS)('a project file that is itself a link', () => {
  it('still confirms the handle: the link target swapped for an outside link is refused', async () => {
    // CLAUDE.md leads to docs/real.md inside the project. The scan resolves it and opens the real
    // path; a writer replaces that file by a link to an outside file just before the open. The
    // confirm that guards every other project file must guard this one too.
    const docs = join(project, 'docs');
    mkdirSync(docs);
    const real = join(docs, 'real.md');
    writeFileSync(real, '# Project\nThe project own instructions.\n');
    symlinkSync(real, join(project, 'CLAUDE.md'));
    const secret = join(tempDir, 'outside', 'secret.md');
    writeFileSync(secret, `# Secret\n${OUTSIDE}\n`);
    hooks.prefix = real;
    hooks.open = () => {
      renameSync(real, `${real}.orig`);
      symlinkSync(secret, real);
    };

    const result = await detectAgentConfigs(project);

    expect(hooks.calls.open).toBe(1);
    expect(JSON.stringify(result.entries)).not.toContain(OUTSIDE);
    const claudeMd = join(project, 'CLAUDE.md');
    expect(result.entries.find((entry) => entry.filePath === claudeMd)).toBeUndefined();
    const warnings = result.errors.filter((error) => error.filePath === claudeMd);
    expect(warnings).toHaveLength(1);
    expect(getParseSeverity(warnings[0])).toBe('warning');
  });
});
