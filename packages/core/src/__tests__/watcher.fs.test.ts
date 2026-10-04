import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultWatcher } from '../watcher/index.js';

// Real chokidar on a real temp tree: the mocked unit tests cannot notice that
// chokidar 4 dropped glob support, so this file is the only proof that the
// watcher actually delivers events for every markdown source type.

const EVENT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;
// Must exceed the watcher's 300 ms awaitWriteFinish threshold, otherwise
// back-to-back probe writes keep the file "unstable" and no event ever fires.
const READY_PROBE_INTERVAL_MS = 800;
const IS_WINDOWS = process.platform === 'win32';

type Observed = { event: string; path: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${EVENT_TIMEOUT_MS} ms waiting for ${what}`);
}

describe('VaultWatcher with real chokidar', () => {
  let claudePath: string;
  let watcher: VaultWatcher;
  let observed: Observed[];
  let probeCount: number;
  let probePaths: string[];

  beforeEach(async () => {
    // realpath: macOS reports /private/var/... for paths created under /var/...
    claudePath = await realpath(await mkdtemp(join(tmpdir(), 'cv-watcher-')));
    for (const dir of ['skills', 'agents', 'commands', 'rules', 'plugins']) {
      await mkdir(join(claudePath, dir), { recursive: true });
    }
    watcher = new VaultWatcher(claudePath);
    observed = [];
    probeCount = 0;
    probePaths = [];
  });

  afterEach(async () => {
    await watcher.stop();
    await rm(claudePath, { recursive: true, force: true });
  });

  const pathOf = (...segments: string[]): string => join(claudePath, ...segments);

  const hasEvent = (event: string, path: string, fromIndex = 0): boolean =>
    observed.slice(fromIndex).some((o) => o.event === event && o.path === path);

  async function expectEvent(event: string, path: string, fromIndex: number): Promise<void> {
    await waitUntil(() => hasEvent(event, path, fromIndex), `${event} for ${path}`);
  }

  // VaultWatcher exposes no ready signal, and changes made while chokidar is
  // still scanning a watched root are lost (ignoreInitial). Rewriting one probe
  // file per watched root until each has produced an event proves every root is
  // live; one root being live says nothing about the others. The literal probe
  // worked before the fix, so a broken watcher fails on the markdown probes with
  // a message naming the silent root. Probes are pre-created so each signal is a
  // change to a file chokidar already tracks, the most dependable event on all
  // three platforms.
  async function startAndWaitUntilLive(literalProbe: string[]): Promise<void> {
    const probes = [pathOf(...literalProbe)];
    const candidates = [
      ['skills', '_probe', 'SKILL.md'],
      ['agents', '_probe.md'],
      ['commands', '_probe.md'],
      ['rules', '_probe.md'],
    ];
    for (const segments of candidates) {
      const [section] = segments;
      if (section === undefined || !(await exists(pathOf(section)))) continue;
      await mkdir(pathOf(...segments.slice(0, -1)), { recursive: true });
      probes.push(pathOf(...segments));
    }
    probePaths = probes;
    await rewriteProbes(probes);

    watcher.start((event, path) => {
      observed.push({ event, path });
    });

    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await rewriteProbes(probes);
      await sleep(READY_PROBE_INTERVAL_MS);
      if (probes.every((probe) => observed.some((o) => o.path === probe))) return;
    }
    const silent = probes.filter((probe) => !observed.some((o) => o.path === probe));
    throw new Error(`watcher delivered no event for readiness probe(s): ${silent.join(', ')}`);
  }

  async function rewriteProbes(probes: string[]): Promise<void> {
    probeCount += 1;
    // A growing body changes the size, so even coarse mtime clocks see a change.
    const body = JSON.stringify({ probe: probeCount, pad: 'x'.repeat(probeCount) });
    for (const probe of probes) {
      await writeFile(probe, body);
    }
  }

  const mark = (): number => observed.length;

  async function expectLifecycle(segments: string[]): Promise<void> {
    const filePath = pathOf(...segments);
    await mkdir(pathOf(...segments.slice(0, -1)), { recursive: true });

    let cursor = mark();
    await writeFile(filePath, '# created\n');
    await expectEvent('add', filePath, cursor);

    cursor = mark();
    await writeFile(filePath, '# modified with a different length\n');
    await expectEvent('change', filePath, cursor);

    cursor = mark();
    await rm(filePath);
    await expectEvent('unlink', filePath, cursor);
  }

  it(
    'reports create, modify and delete of a skill SKILL.md',
    async () => {
      await startAndWaitUntilLive(['settings.json']);
      await expectLifecycle(['skills', 'my-skill', 'SKILL.md']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports create, modify and delete of an agent markdown file',
    async () => {
      await startAndWaitUntilLive(['settings.json']);
      await expectLifecycle(['agents', 'x.md']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports create, modify and delete of a nested command markdown file',
    async () => {
      await startAndWaitUntilLive(['settings.json']);
      await expectLifecycle(['commands', 'sub', 'dir', 'y.md']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports create, modify and delete of a rule markdown file',
    async () => {
      await startAndWaitUntilLive(['settings.json']);
      await expectLifecycle(['rules', 'z.md']);
    },
    TEST_TIMEOUT_MS,
  );

  // These two files worked before the fix, so they stay as regression guards:
  // the target exists at start and the assertion is on its change event.
  it(
    'reports edits to plugins/installed_plugins.json',
    async () => {
      const file = pathOf('plugins', 'installed_plugins.json');
      await writeFile(file, '{"plugins":[]}');
      await startAndWaitUntilLive(['settings.json']);

      const cursor = mark();
      await writeFile(file, '{"plugins":["a-longer-value"]}');
      await expectEvent('change', file, cursor);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports edits to settings.json',
    async () => {
      // Probe through a different literal file so settings.json events below
      // cannot be late probe events.
      const file = pathOf('settings.json');
      await writeFile(file, '{"hooks":{}}');
      await startAndWaitUntilLive(['plugins', 'installed_plugins.json']);

      const cursor = mark();
      await writeFile(file, '{"hooks":{"PreToolUse":[]}}');
      await expectEvent('change', file, cursor);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'picks up a watched directory that is created after the watcher started',
    async () => {
      await rm(pathOf('rules'), { recursive: true, force: true });
      await startAndWaitUntilLive(['settings.json']);

      const file = pathOf('rules', 'late.md');
      const cursor = mark();
      await mkdir(pathOf('rules'), { recursive: true });
      await writeFile(file, '# late\n');
      await expectEvent('add', file, cursor);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ignores files that are not vault sources',
    async () => {
      // Created before start so chokidar tracks them from the initial scan; a
      // directory made after start may not be watched yet when the noise is
      // written, which would let a leaked event go unnoticed.
      await mkdir(pathOf('skills', 'tidy'), { recursive: true });
      await mkdir(pathOf('agents', 'nested'), { recursive: true });
      await mkdir(pathOf('commands', 'sub'), { recursive: true });
      await startAndWaitUntilLive(['settings.json']);

      const cursor = mark();
      const ignoredFiles = [
        ['README.txt'],
        ['rules', 'notes.txt'],
        ['rules', '.z.md.swp'],
        ['rules', 'z.md~'],
        ['rules', '.#z.md'],
        ['skills', 'tidy', 'README.md'],
        ['skills', 'tidy', 'SKILL.md.swp'],
        ['agents', 'nested', 'deep.md'],
        ['commands', 'sub', 'notes.txt'],
      ];
      for (const segments of ignoredFiles) {
        await writeFile(pathOf(...segments), 'noise');
      }

      // Fresh control files follow the noise: once one is reported, every
      // ignored write above had the same opportunity to be reported. A new file
      // is written per attempt because chokidar can miss a file created while it
      // is still re-reading a directory that just saw a burst of writes.
      const controls: string[] = [];
      const deadline = Date.now() + EVENT_TIMEOUT_MS;
      while (Date.now() < deadline && !controls.some((c) => hasEvent('add', c, cursor))) {
        const control = pathOf('rules', `control-${controls.length}.md`);
        controls.push(control);
        await writeFile(control, '# control\n');
        await sleep(READY_PROBE_INTERVAL_MS);
      }
      expect(controls.some((c) => hasEvent('add', c, cursor))).toBe(true);

      const leaked = observed
        .slice(cursor)
        .filter((o) => !controls.includes(o.path) && !probePaths.includes(o.path));
      expect(leaked).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // Creating directory symlinks on Windows needs elevated rights or developer
  // mode, and junction event delivery through fs.watch cannot be verified from
  // the macOS development host, so the assertion is skipped there. The
  // followSymlinks option itself is pinned in the mocked unit test.
  it.skipIf(IS_WINDOWS)(
    'follows a symlinked skill folder',
    async () => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'cv-watcher-target-')));
      try {
        const linkedSkill = join(outside, 'linked-skill');
        await mkdir(linkedSkill, { recursive: true });
        await writeFile(join(linkedSkill, 'SKILL.md'), '# linked\n');
        await symlink(linkedSkill, pathOf('skills', 'linked'), 'dir');

        await startAndWaitUntilLive(['settings.json']);
        const viaLink = pathOf('skills', 'linked', 'SKILL.md');

        const cursor = mark();
        await writeFile(join(linkedSkill, 'SKILL.md'), '# linked and edited with a longer body\n');
        await expectEvent('change', viaLink, cursor);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // A symlink that points back at an ancestor makes chokidar emit ELOOP once
  // symlinks are followed. Unhandled, that 'error' event kills the host process
  // (CLI or VS Code extension host), so the watcher must survive it.
  it.skipIf(IS_WINDOWS)(
    'survives a symlink cycle and still reports normal edits',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const skillDir = pathOf('skills', 'a');
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, 'SKILL.md'), '# a\n');
        await symlink(pathOf('skills'), join(skillDir, 'loop'), 'dir');

        await startAndWaitUntilLive(['settings.json']);

        const cursor = mark();
        await writeFile(join(skillDir, 'SKILL.md'), '# a edited with a longer body\n');
        await expectEvent('change', join(skillDir, 'SKILL.md'), cursor);
        await waitUntil(() => warn.mock.calls.length > 0, 'a warning about the symlink cycle');
      } finally {
        warn.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
