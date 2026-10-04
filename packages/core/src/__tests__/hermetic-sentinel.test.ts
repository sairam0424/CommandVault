import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the hermetic harness BITES. A child vitest run uses the real test-support global setup
 * and setup file, with a fake "real" home as its launch HOME. A check that reaches that fake real
 * home (which is exactly what a test touching the developer's ~/.commandvault would do) must fail
 * the whole run; a check that stays inside the per-worker temp HOME must not.
 */

vi.setConfig({ testTimeout: 120_000 });

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const GLOBAL_SETUP = join(REPO_ROOT, 'test-support', 'global-setup.ts');
const SETUP_FILE = join(REPO_ROOT, 'test-support', 'hermetic-home.ts');
const VITEST_CLI = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

interface ChildRun {
  readonly status: number | null;
  readonly output: string;
  readonly seenHome: string | null;
}

interface Scenario {
  /** Creates whatever already exists in the fake real home before the run. */
  readonly seed: (realHome: string) => void;
  /** Extra variables in the environment the child run is LAUNCHED with, e.g. a redirected data dir. */
  readonly launchEnv?: (realHome: string) => Readonly<Record<string, string>>;
  /** Body of the one check the child runs; `realHome` and `seenHomeFile` are in scope. */
  readonly body: string;
  /** The vitest pool the child run uses; the harness supports `forks` only. */
  readonly pool?: 'forks' | 'threads';
}

function pick(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(
    keys.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

function writeChildProject(project: string, body: string, pool: string): void {
  writeFileSync(
    join(project, 'vitest.config.mjs'),
    `export default {
      server: { fs: { allow: [${JSON.stringify(REPO_ROOT)}] } },
      test: {
        pool: ${JSON.stringify(pool)}, globals: true, include: ['*.check.mjs'],
        globalSetup: [${JSON.stringify(GLOBAL_SETUP)}],
        setupFiles: [${JSON.stringify(SETUP_FILE)}],
      },
    };\n`,
  );
  writeFileSync(
    join(project, 'a.check.mjs'),
    `import { chmodSync, mkdirSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs';
     import { homedir } from 'node:os';
     import { join } from 'node:path';
     const realHome = process.env.CV_FAKE_REAL_HOME;
     const seenHomeFile = process.env.CV_SEEN_HOME_FILE;
     it('check', () => {
       writeFileSync(seenHomeFile, homedir());
       ${body}
     });\n`,
  );
}

const CHILD_TIMEOUT_MS = 90_000;

function runChild(scenario: Scenario): Promise<ChildRun> {
  // Vite resolves symlinks (/tmp is one on macOS) and Windows 8.3 short names (RUNNER~1); a canonical
  // root keeps the test file inside it.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cv-sentinel-selftest-')));
  const realHome = join(root, 'real-home');
  const project = join(root, 'project');
  const seenHomeFile = join(root, 'seen-home.txt');
  mkdirSync(realHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  scenario.seed(realHome);
  writeChildProject(project, scenario.body, scenario.pool ?? 'forks');

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [VITEST_CLI, 'run', '--root', project, '--config', join(project, 'vitest.config.mjs')],
      {
        cwd: project,
        env: {
          ...pick(process.env, ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']),
          HOME: realHome,
          USERPROFILE: realHome,
          NO_COLOR: '1',
          CI: '1',
          CV_FAKE_REAL_HOME: realHome,
          CV_SEEN_HOME_FILE: seenHomeFile,
          ...scenario.launchEnv?.(realHome),
        },
      },
    );
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    // A stalled child must fail this test with its output, not hold the temp dir until the test times out.
    const watchdog = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(watchdog);
      const seenHome = existsSync(seenHomeFile) ? readFileSync(seenHomeFile, 'utf8') : null;
      rmSync(root, { recursive: true, force: true });
      resolve({ status, output, seenHome });
    });
  });
}

// Whole-second mtimes survive a utimes round trip exactly, so "touched back" is a true no-op.
const SEEDED_MTIME = 978_307_200; // 2001-01-01T00:00:00Z
const CHANGED_MTIME = 1_009_843_200; // 2002-01-01T00:00:00Z

const seedBoth = (realHome: string): void => {
  const db = join(realHome, '.commandvault', 'vault.db');
  const skills = join(realHome, '.claude', 'skills');
  mkdirSync(join(realHome, '.commandvault'), { recursive: true });
  writeFileSync(db, 'original');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(realHome, '.claude', 'settings.json'), '{}');
  utimesSync(db, SEEDED_MTIME, SEEDED_MTIME);
  utimesSync(skills, SEEDED_MTIME, SEEDED_MTIME);
};

const CUSTOM_DATA = 'custom-data';
const CUSTOM_CLAUDE = 'custom-claude';

/** A data dir and a Claude dir that live OUTSIDE the default `<home>/.commandvault` and `<home>/.claude`. */
const seedRedirected = (realHome: string): void => {
  seedBoth(realHome);
  const data = join(realHome, CUSTOM_DATA);
  const claude = join(realHome, CUSTOM_CLAUDE);
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'vault.db'), 'original');
  mkdirSync(join(claude, 'skills'), { recursive: true });
  utimesSync(join(data, 'vault.db'), SEEDED_MTIME, SEEDED_MTIME);
  utimesSync(join(claude, 'skills'), SEEDED_MTIME, SEEDED_MTIME);
};

/** The launching shell exports both variables as absolute paths into the fake real home. */
const redirectAbsolute = (realHome: string): Record<string, string> => ({
  COMMANDVAULT_HOME: join(realHome, CUSTOM_DATA),
  CLAUDE_CONFIG_DIR: join(realHome, CUSTOM_CLAUDE),
});

/** ...or with a leading `~/`, which the production resolvers expand against the launching HOME. */
const redirectTilde = (): Record<string, string> => ({
  COMMANDVAULT_HOME: `~/${CUSTOM_DATA}`,
  CLAUDE_CONFIG_DIR: `~/${CUSTOM_CLAUDE}`,
});

const SAFE: Scenario = {
  seed: seedRedirected,
  launchEnv: redirectAbsolute,
  body: `
    // The launching env exported both variables; the setup file must have replaced them.
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // join(), not a '/' concatenation: the setup file builds it with join(), a backslash on Windows.
    expect(process.env.COMMANDVAULT_HOME).toBe(join(homedir(), '.commandvault'));
    mkdirSync(homedir() + '/.commandvault', { recursive: true });
    writeFileSync(homedir() + '/.commandvault/vault.db', 'in the temp home');
    mkdirSync(homedir() + '/.claude/skills', { recursive: true });
    writeFileSync(homedir() + '/.claude/settings.json', '{"temp":true}');
  `,
};

const INTRUDERS: readonly (readonly [string, Scenario, RegExp])[] = [
  [
    'a new file in the real data directory',
    { seed: seedBoth, body: `writeFileSync(realHome + '/.commandvault/zz', 'x');` },
    /added .*\.commandvault.zz/,
  ],
  [
    'a database rewritten to a different size with its mtime put back',
    {
      seed: seedBoth,
      body: `
        const db = realHome + '/.commandvault/vault.db';
        writeFileSync(db, 'original and much longer');
        utimesSync(db, ${SEEDED_MTIME}, ${SEEDED_MTIME});`,
    },
    /modified .*vault\.db \(size 8 -> 24/,
  ],
  [
    'a database touched without changing its size',
    {
      seed: seedBoth,
      body: `utimesSync(realHome + '/.commandvault/vault.db', ${CHANGED_MTIME}, ${CHANGED_MTIME});`,
    },
    /modified .*vault\.db \(size 8 -> 8/,
  ],
  [
    'a file deleted from the real data directory',
    { seed: seedBoth, body: `unlinkSync(realHome + '/.commandvault/vault.db');` },
    /removed .*\.commandvault.vault\.db/,
  ],
  [
    'a file written to the data directory COMMANDVAULT_HOME redirects to',
    {
      seed: seedRedirected,
      launchEnv: redirectAbsolute,
      body: `writeFileSync(realHome + '/${CUSTOM_DATA}/zz', 'x');`,
    },
    new RegExp(`added .*${CUSTOM_DATA}.zz`),
  ],
  [
    'a file written to the data directory a ~/ COMMANDVAULT_HOME redirects to',
    {
      seed: seedRedirected,
      launchEnv: redirectTilde,
      body: `writeFileSync(realHome + '/${CUSTOM_DATA}/zz', 'x');`,
    },
    new RegExp(`added .*${CUSTOM_DATA}.zz`),
  ],
  [
    'a top-level entry added to the Claude directory CLAUDE_CONFIG_DIR redirects to',
    {
      seed: seedRedirected,
      launchEnv: redirectAbsolute,
      body: `writeFileSync(realHome + '/${CUSTOM_CLAUDE}/stray.md', 'x');`,
    },
    new RegExp(`added .*${CUSTOM_CLAUDE}.stray\\.md`),
  ],
  [
    'a top-level entry added to the Claude directory a ~/ CLAUDE_CONFIG_DIR redirects to',
    {
      seed: seedRedirected,
      launchEnv: redirectTilde,
      body: `writeFileSync(realHome + '/${CUSTOM_CLAUDE}/stray.md', 'x');`,
    },
    new RegExp(`added .*${CUSTOM_CLAUDE}.stray\\.md`),
  ],
  [
    'a file written to the DEFAULT data directory while COMMANDVAULT_HOME redirects elsewhere',
    {
      seed: seedRedirected,
      launchEnv: redirectAbsolute,
      body: `writeFileSync(realHome + '/.commandvault/zz', 'x');`,
    },
    /added .*\.commandvault.zz/,
  ],
  [
    'a top-level entry added to the DEFAULT Claude directory while CLAUDE_CONFIG_DIR redirects',
    {
      seed: seedRedirected,
      launchEnv: redirectAbsolute,
      body: `writeFileSync(realHome + '/.claude/stray.md', 'x');`,
    },
    /added .*\.claude.stray\.md/,
  ],
  [
    'a real data directory that did not exist before',
    { seed: () => undefined, body: `mkdirSync(realHome + '/.commandvault', { recursive: true });` },
    /\.commandvault went from missing to present/,
  ],
  [
    'a new top-level entry in the real Claude directory',
    { seed: seedBoth, body: `writeFileSync(realHome + '/.claude/stray.md', 'x');` },
    /added .*\.claude.stray\.md/,
  ],
  [
    'a changed mtime on a top-level entry of the real Claude directory',
    {
      seed: seedBoth,
      body: `utimesSync(realHome + '/.claude/skills', ${CHANGED_MTIME}, ${CHANGED_MTIME});`,
    },
    /modified .*\.claude.skills/,
  ],
];

describe('hermetic test harness', () => {
  it('passes a run that only touches its own temp HOME, and cleans that HOME up', async () => {
    const run = await runChild(SAFE);

    expect(run.output).toMatch(/1 passed/);
    expect(run.status).toBe(0);
    expect(run.seenHome).not.toBeNull();
    expect(existsSync(run.seenHome as string)).toBe(false);
  });

  // Every case spawns a nested vitest. On the Windows CI runner two of sixteen stalled for the whole
  // test timeout (then EBUSY while removing their temp dir), so there only the passing run above and
  // the per-package wiring tests run. The comparison logic is platform independent and is fully
  // exercised on Linux and macOS.
  describe.skipIf(process.platform === 'win32')('intruders', () => {
    it.each(INTRUDERS)('fails a run with %s', async (_name, scenario, expected) => {
      const run = await runChild(scenario);

      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/changed the REAL CommandVault data directory/);
      expect(run.output).toMatch(expected);
    });
  });

  it('refuses to run tests on the threads pool, where the temp HOME cannot take effect', async () => {
    // A worker thread has its own copy of process.env, so os.homedir() would keep returning the
    // launching HOME and the tests would run against it. The check itself must never run.
    const run = await runChild({
      seed: seedBoth,
      pool: 'threads',
      body: `writeFileSync(realHome + '/.commandvault/zz', 'x');`,
    });

    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/forks pool/);
    // The check writes `seenHome` before anything else, so no file means its body never ran.
    expect(run.seenHome).toBeNull();
  });

  // chmod cannot make a directory read-only on Windows, and root ignores the mode.
  const canLockDirectories = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canLockDirectories)(
    'still reports a real-home change when the temp HOME cannot be removed',
    async () => {
      const run = await runChild({
        seed: seedBoth,
        body: `
          mkdirSync(homedir() + '/locked');
          writeFileSync(homedir() + '/locked/file', 'x');
          chmodSync(homedir() + '/locked', 0o500);
          writeFileSync(realHome + '/.commandvault/zz', 'x');`,
      });
      // The run root could not be deleted either; unlock it so this test does not leak it.
      const tempHome = run.seenHome as string;
      chmodSync(join(tempHome, 'locked'), 0o700);
      rmSync(dirname(tempHome), { recursive: true, force: true });

      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/added .*\.commandvault.zz/);
      expect(run.output).toMatch(/Could not remove the temp HOMEs/);
    },
  );
});
