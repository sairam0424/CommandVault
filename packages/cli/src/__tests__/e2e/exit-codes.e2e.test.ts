import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_ENTRY_NAMES,
  IS_WINDOWS,
  context,
  createSandbox,
  entriesOf,
  parseJson,
  writeConfigFile,
  type RunResult,
  type Sandbox,
} from './harness.js';

/**
 * Exit codes, error channels and process-level behaviour of the BUILT binary.
 *
 * Convention under test: usage or validation error -> exit 2, runtime or user error -> exit 1,
 * SIGINT -> 130, SIGTERM -> 143. Every user-facing failure is ONE `error: <message>` line on
 * stderr (never a stack trace unless VAULT_DEBUG=1) and leaves stdout empty.
 */

vi.setConfig({ testTimeout: 60_000 });

const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;
const TIER_HINT = '(expected sqlite, minisearch or fuse)';

let box: Sandbox;

beforeAll(() => {
  box = createSandbox();
});

afterAll(() => {
  box?.dispose();
});

const run = (args: readonly string[]) => box.run(args);

function errorLines(result: RunResult): string[] {
  return result.stderr.split('\n').filter((line) => line.startsWith('error:'));
}

function expectFailure(result: RunResult, status: number, message: RegExp): void {
  expect(result.status, context(result)).toBe(status);
  expect(result.stderr, context(result)).toMatch(message);
  expect(errorLines(result), context(result)).toHaveLength(1);
  expect(result.stdout, context(result)).toBe('');
  expect(result.stderr, context(result)).not.toMatch(/^\s+at /m);
}

describe('built CLI: usage errors exit 2', () => {
  it.each([
    ['an unknown command', ['bogus'], /^error: .*(unknown command|too many arguments)/m],
    ['a missing required argument', ['search'], /^error: missing required argument 'query'/m],
    ['an unknown option', ['list', '--nonsense'], /^error: unknown option '--nonsense'/m],
    [
      'a missing subcommand argument',
      ['config', 'set', 'searchTier'],
      /^error: missing required argument/m,
    ],
    [
      'an invalid --type',
      ['list', '--type', 'bogus'],
      /^error: invalid --type "bogus" \(expected skill, agent, command, plugin, rule or hook\)/m,
    ],
    [
      'an out-of-range --limit',
      ['search', 'demo', '--limit', '0'],
      /^error: --limit must be a number between 1 and 1000/m,
    ],
    ['a sync source that is not http(s)', ['sync', 'ftp://example.com/x.json'], /must start with/],
    ['a restore argument that is a path', ['restore', '../vault.db'], /only backup filenames/],
    ['favorite without a name or --type', ['favorite'], /^error: usage: vault favorite/m],
    ['tag add without a tag', ['tag', 'add', 'demo-skill'], /^error: usage: vault tag add/m],
    [
      'tag add with no name',
      ['tag', 'add'],
      /^error: usage: vault tag <action> <name> \[tag\] or vault tag <action> <tag> --type <type>/m,
    ],
    [
      'tag add --type with no tag',
      ['tag', 'add', '--type', 'skill'],
      /^error: usage: vault tag add <tag> --type <type>/m,
    ],
    [
      'tag remove without a tag',
      ['tag', 'remove', 'demo-skill'],
      /^error: usage: vault tag remove <name> <tag>/m,
    ],
    ['tag with an unknown action', ['tag', 'frobnicate', 'demo-skill'], /unknown action "frobnic/],
    ['completions for an unknown shell', ['completions', 'tcsh'], /^error: .*tcsh/m],
    [
      'favorite with an invalid --type',
      ['favorite', '--type', 'bogus'],
      /^error: invalid --type "bogus"/m,
    ],
    [
      'tag with an invalid --type',
      ['tag', 'add', 'x', '--type', 'bogus'],
      /^error: invalid --type "bogus"/m,
    ],
    [
      'tag --type with an unsupported action',
      ['tag', 'list', '--type', 'skill'],
      /^error: bulk mode only supports/m,
    ],
    [
      'registry add with an invalid URL',
      ['registry', 'add', 'foo', 'notaurl'],
      /^error: invalid URL "notaurl"/m,
    ],
  ])('%s', (_name, args, message) => {
    expectFailure(run(args), EXIT_USAGE, message);
  });
});

describe('built CLI: --tier is validated before any work happens', () => {
  it.each([
    ['search demo --tier bogus', ['search', 'demo', '--tier', 'bogus']],
    ['list --tier bogus', ['list', '--tier', 'bogus']],
    ['the option placed before the command', ['--tier', 'bogus', 'stats']],
  ])('%s', (_name, args) => {
    const result = run(args);
    expectFailure(result, EXIT_USAGE, /^error: invalid --tier "bogus" \(expected/m);
    expect(errorLines(result)[0]).toBe(`error: invalid --tier "bogus" ${TIER_HINT}`);
    expect(result.stderr, 'the vault was never opened').not.toMatch(/Initializing vault/);
  });

  it.each(['sqlite', 'minisearch', 'fuse'])('--tier %s is accepted', (tier) => {
    const result = run(['search', 'demo', '--tier', tier, '--json']);
    expect(result.status, context(result)).toBe(0);
    expect(parseJson<{ results: unknown[] }>(result).results.length).toBeGreaterThan(0);
  });

  it('an invalid searchTier in config.json is rejected the same way', () => {
    const sandbox = createSandbox();
    try {
      writeConfigFile(sandbox, { searchTier: 'bogus' });
      const result = sandbox.run(['list']);
      expectFailure(result, EXIT_USAGE, /^error: invalid searchTier "bogus" in .*config\.json/m);
      expect(errorLines(result)[0]).toContain(TIER_HINT);
    } finally {
      sandbox.dispose();
    }
  });
});

describe('built CLI: --claude-path is validated', () => {
  it('rejects a directory that does not exist, and does not create it', () => {
    const missing = join(box.workDir, 'no-such-claude-dir');
    const result = run(['list', '--claude-path', missing]);
    expectFailure(
      result,
      EXIT_USAGE,
      /^error: --claude-path ".*no-such-claude-dir" does not exist/m,
    );
    expect(existsSync(missing)).toBe(false);
    expect(result.stderr, 'the vault was never opened').not.toMatch(/Initializing vault/);
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
  ])('rejects %s instead of scanning the current directory', (_name, value) => {
    const result = run(['--claude-path', value, 'list', '--json']);
    expectFailure(result, EXIT_USAGE, /^error: --claude-path must not be empty/m);
  });

  it('rejects a path that is a file', () => {
    const file = join(box.workDir, 'a-file.txt');
    writeFileSync(file, 'not a directory');
    const result = run(['list', '--claude-path', file]);
    expectFailure(result, EXIT_USAGE, /^error: --claude-path ".*a-file\.txt" is not a directory/m);
  });

  it.skipIf(IS_WINDOWS)('resolves a leading ~ against the home directory', () => {
    const names = entriesOf(run(['list', '--json', '--claude-path', '~/.claude'])).map(
      (entry) => entry.name,
    );
    expect(names.sort()).toEqual([...FIXTURE_ENTRY_NAMES].sort());
  });

  it('still accepts an existing directory', () => {
    const result = run(['list', '--json', '--claude-path', box.altClaudeDir]);
    expect(result.status, context(result)).toBe(0);
  });
});

describe('built CLI: runtime and user errors exit 1', () => {
  it.each([
    ['info of a missing entry', ['info', 'zzzznomatch'], /^error: no entry found matching "zzzz/m],
    ['run of a missing entry', ['run', 'zzzznomatch'], /^error: no entry found matching "zzzz/m],
    ['open of a missing entry', ['open', 'zzzznomatch'], /^error: no entry found matching "zzzz/m],
    [
      'favorite of a missing entry',
      ['favorite', 'zzzznomatch'],
      /^error: no entry found matching "zzzz/m,
    ],
    [
      'tag of a missing entry',
      ['tag', 'add', 'zzzznomatch', 'x'],
      /^error: no entry found matching "zzzz/m,
    ],
    [
      'import of a missing file',
      ['import', join('nope', 'missing.vault.json')],
      /^error: no valid entries found in source/m,
    ],
    [
      'import --dry-run of a missing file',
      ['import', 'missing.vault.json', '--dry-run'],
      /^error: no valid entries found in source/m,
    ],
    ['restore of a missing backup', ['restore', 'no-such-backup.db'], /^error: backup file not/m],
    [
      'favorite --type with no entries of that type',
      ['favorite', '--type', 'plugin'],
      /^error: no entries found of type "plugin"/m,
    ],
    [
      'tag --type with no entries of that type',
      ['tag', 'add', 'x', '--type', 'plugin'],
      /^error: no entries found of type "plugin"/m,
    ],
    [
      'registry remove of an unknown registry',
      ['registry', 'remove', 'zzz'],
      /^error: registry "zzz" not found/m,
    ],
    [
      'sync of a private address',
      ['sync', 'https://127.0.0.1/registry.json', '--dry-run'],
      /^error: .*private\/internal URL/m,
    ],
  ])('%s', (_name, args, message) => {
    expectFailure(run(args), EXIT_RUNTIME, message);
  });

  it('backup before the database exists fails with a hint', () => {
    const sandbox = createSandbox();
    try {
      const result = sandbox.run(['backup']);
      expectFailure(result, EXIT_RUNTIME, /^error: backup failed: /m);
      expect(result.stderr, context(result)).toMatch(/^hint: run `vault list` first/m);
    } finally {
      sandbox.dispose();
    }
  });

  it('registry add of a name that already exists fails with a hint', () => {
    const sandbox = createSandbox();
    try {
      const added = sandbox.run(['registry', 'add', 'foo', 'https://example.com/index.json']);
      expect(added.status, context(added)).toBe(0);
      const result = sandbox.run(['registry', 'add', 'foo', 'https://example.com/other.json']);
      expectFailure(result, EXIT_RUNTIME, /^error: registry "foo" already exists/m);
      expect(result.stderr, context(result)).toMatch(/^hint: remove it first/m);
    } finally {
      sandbox.dispose();
    }
  });

  it('init with an existing config that is invalid JSON fails and does not touch the file', () => {
    const sandbox = createSandbox();
    try {
      writeConfigFile(sandbox, '{bad');
      const result = sandbox.run(['init']);
      expect(result.status, context(result)).toBe(EXIT_RUNTIME);
      expect(errorLines(result), context(result)).toEqual([
        'error: existing config is invalid JSON',
      ]);
      expect(result.stderr, context(result)).toMatch(/^hint: run `vault init --reset`/m);
      expect(readFileSync(join(sandbox.home, '.commandvault', 'config.json'), 'utf8')).toBe('{bad');
    } finally {
      sandbox.dispose();
    }
  });

  it('restore fails when the backup cannot be copied', () => {
    const sandbox = createSandbox();
    try {
      // Readable, so the existence check passes, but a directory cannot be copied over the database.
      mkdirSync(join(sandbox.home, '.commandvault', 'backups', 'not-a-file.db'), {
        recursive: true,
      });
      const result = sandbox.run(['restore', 'not-a-file.db']);
      expectFailure(result, EXIT_RUNTIME, /^error: restore failed: /m);
    } finally {
      sandbox.dispose();
    }
  });

  it('open fails when the editor cannot be launched', () => {
    const editor = join(box.workDir, 'no-such-editor');
    const result = box.run(['open', 'demo-skill'], { EDITOR: editor });
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(errorLines(result), context(result)).toEqual([
      `error: failed to open editor (${editor})`,
    ]);
    expect(result.stderr, context(result)).toMatch(/^hint: set \$EDITOR to override/m);
  });

  it('info --json of a missing entry still prints a valid JSON document, then exits 1', () => {
    const result = run(['info', 'zzzznomatch', '--json']);
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(parseJson<{ entry: unknown }>(result)).toEqual({ entry: null });
    expect(errorLines(result)).toHaveLength(1);
  });

  it('shows the stack only when VAULT_DEBUG=1', () => {
    const quiet = box.run(['info', 'zzzznomatch']);
    const debug = box.run(['info', 'zzzznomatch'], { VAULT_DEBUG: '1' });
    expect(quiet.stderr).not.toMatch(/^\s+at /m);
    expect(debug.status, context(debug)).toBe(EXIT_RUNTIME);
    expect(debug.stderr, context(debug)).toMatch(/^\s+at /m);
  });

  it.each([
    ['config help', ['config', 'help']],
    ['config help get', ['config', 'help', 'get']],
    ['registry help', ['registry', 'help']],
    ['config --help', ['config', '--help']],
  ])('%s prints help, exits 0 and leaves stderr empty', (_label, args) => {
    const result = run(args);
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout, context(result)).toMatch(/^Usage: /m);
    expect(result.stderr, context(result)).toBe('');
  });

  it('successful commands still exit 0 with an empty error channel for the data', () => {
    const result = run(['run', 'demo-skill']);
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout.trim()).toBe('/demo-skill');
    expect(errorLines(result)).toEqual([]);
  });
});

describe('built CLI: a prompt whose input has already ended', () => {
  // stdin is at EOF (`</dev/null`): the legacy prompt can never be answered. That is a failed
  // run (exit 1 with one error: line), not a Ctrl+C (130) and not Node's "unsettled top-level
  // await" warning.
  it.each([
    ['the default command', ['--no-tui']],
    ['interactive --no-tui', ['interactive', '--no-tui']],
  ])('%s exits 1 with one error line', (_name, args) => {
    const result = run(args);
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(errorLines(result), context(result)).toHaveLength(1);
    expect(result.stderr, context(result)).not.toMatch(/Warning|unsettled|^\s+at /m);
  });
});

describe('built CLI: --json stdout stays a single JSON document', () => {
  // A malformed config.json makes loadConfig warn; that warning must not reach stdout.
  it.each([
    ['list', ['list', '--json']],
    ['search', ['search', 'demo', '--json']],
    ['info', ['info', 'demo-skill', '--json']],
    ['run', ['run', 'demo-skill', '--json']],
    ['stats', ['stats', '--json']],
    ['audit', ['audit', '--json']],
  ])('%s with a config warning present', (_name, args) => {
    const sandbox = createSandbox();
    try {
      writeConfigFile(sandbox, '{not valid json');
      const result = sandbox.run(args);
      expect(result.status, context(result)).toBe(0);
      expect(result.stderr, context(result)).toMatch(/Malformed JSON in config file/);
      expect(() => JSON.parse(result.stdout), context(result)).not.toThrow();
    } finally {
      sandbox.dispose();
    }
  });
});

describe('built CLI: process-level behaviour', () => {
  it('a closed stdout (EPIPE) ends quietly with exit 0 and no stack trace', async () => {
    const result = await box.runWithClosedStdout(['completions', 'bash']);
    expect(result.status, context(result)).toBe(0);
    expect(result.stderr, context(result)).not.toMatch(/EPIPE|^\s+at |node:events/m);
  });

  it('a closed stdout during a vault command is quiet too', async () => {
    const result = await box.runWithClosedStdout(['list']);
    expect(result.status, context(result)).toBe(0);
    expect(result.stderr, context(result)).not.toMatch(/EPIPE|^\s+at |node:events/m);
  });

  it.skipIf(IS_WINDOWS)('SIGINT during watch exits 130 after stopping the watcher', async () => {
    const result = await box.runUntil(['watch'], /Watching for changes/, 20_000, 'SIGINT');
    expect(result.matched, context(result)).toBe(true);
    expect(result.status, context(result)).toBe(EXIT_SIGINT);
    expect(result.stderr, context(result)).toMatch(/Stopping watcher/);
  });

  it.skipIf(IS_WINDOWS)('SIGTERM during watch exits 143', async () => {
    const result = await box.runUntil(['watch'], /Watching for changes/, 20_000, 'SIGTERM');
    expect(result.matched, context(result)).toBe(true);
    expect(result.status, context(result)).toBe(EXIT_SIGTERM);
  });
});
