import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CLI,
  FIXTURE_ENTRY_NAMES,
  IS_WINDOWS,
  LOADED_MESSAGE,
  context,
  createSandbox,
  entriesOf,
  expectNoDispatchFailure,
  expectSuccess,
  parseJson,
  registeredCommands,
  type JsonEntry,
  type Sandbox,
} from './harness.js';

/**
 * End-to-end tests over the BUILT binary (`node dist/index.js`) in a sandboxed HOME.
 *
 * Why this exists: every other CLI test attaches a command factory to a bare commander Command,
 * so nothing ever ran the real dispatch in `src/index.ts`. A wrong action signature there made 13
 * of the 22 commands crash in the shipped binary while all unit tests stayed green (CV-G2-001).
 * Requires `pnpm build` first (turbo's `test` task depends on `build`); see harness.ts for the
 * COMMANDVAULT_E2E_CLI override.
 *
 * All tests share one sandbox vault and run in file order. A test that needs earlier state creates
 * it itself (for example by running `list` to create vault.db), so `-t` on a single test behaves
 * the same as the full run.
 */

// Every test spawns one or more real processes; vitest's 5 s default also applies to synchronous
// tests, so chains of spawns on a loaded CI runner would time out spuriously.
vi.setConfig({ testTimeout: 60_000 });

/** Every top-level command the binary is expected to register; checked against `--help`. */
const SUBCOMMANDS = [
  'list',
  'search',
  'info',
  'stats',
  'export',
  'favorite',
  'init',
  'doctor',
  'import',
  'sync',
  'tag',
  'diff',
  'watch',
  'interactive',
  'open',
  'run',
  'backup',
  'restore',
  'config',
  'completions',
  'registry',
  'audit',
];

let box: Sandbox;

const run = (args: readonly string[]) => box.run(args);

beforeAll(() => {
  box = createSandbox();
});

afterAll(() => {
  box?.dispose();
});

describe('built CLI: commands that take a positional argument reach their handler', () => {
  it('search prints the matching entries', () => {
    const result = run(['search', 'demo']);
    expectSuccess(result);
    expect(result.stdout).toMatch(/demo-skill/);
    expect(result.stdout).toMatch(/4 results for "demo"/);
  });

  it('search reports a miss without crashing', () => {
    const result = run(['search', 'zzzznomatch']);
    expectSuccess(result);
    expect(result.stdout).toMatch(/No results found for "zzzznomatch"/);
  });

  it('info shows the entry details', () => {
    const result = run(['info', 'demo-skill']);
    expectSuccess(result);
    expect(result.stdout).toMatch(/Command:\s+\/demo-skill/);
    expect(result.stdout).toMatch(/A demo skill for e2e tests/);
  });

  it('run prints the slash command', () => {
    const result = run(['run', 'demo-skill']);
    expectSuccess(result);
    expect(result.stdout.trim()).toBe('/demo-skill');
  });

  it.skipIf(IS_WINDOWS)('open launches $EDITOR on the entry file', () => {
    const result = run(['open', 'demo-skill']);
    expectSuccess(result);
    expect(readFileSync(box.editorLog, 'utf8')).toContain(join('demo-skill', 'SKILL.md'));
  });

  it('favorite toggles the entry', () => {
    const result = run(['favorite', 'demo-skill']);
    expectSuccess(result);
    expect(result.stdout).toMatch(/Favorited demo-skill/);
  });

  it('tag add then tag list round-trips a user tag', () => {
    const added = run(['tag', 'add', 'demo-skill', 'e2e-tag']);
    expectSuccess(added);
    expect(added.stdout).toMatch(/Added tag e2e-tag to demo-skill/);

    const listed = run(['tag', 'list', 'demo-skill']);
    expectSuccess(listed);
    expect(listed.stdout).toMatch(/\[user\] e2e-tag/);
  });

  it('export writes every entry to the given file', () => {
    expectSuccess(run(['export', 'exported.json']));
    const bundle = JSON.parse(readFileSync(join(box.workDir, 'exported.json'), 'utf8')) as {
      totalEntries: number;
    };
    expect(bundle.totalEntries).toBe(FIXTURE_ENTRY_NAMES.length);
  });

  it.each(['bash', 'zsh', 'fish', 'powershell'])(
    'completions %s mentions every command the binary registers',
    (shell) => {
      const result = run(['completions', shell]);
      expectSuccess(result);
      const names = registeredCommands(run(['--help']).stdout);
      expect(names.length, 'commands parsed from --help').toBeGreaterThan(0);
      for (const name of names) expect(result.stdout, name).toContain(name);
    },
  );

  it.each([
    { alias: 's', args: ['s', 'demo'], stdout: /4 results for "demo"/ },
    { alias: 'nfo', args: ['nfo', 'demo-skill'], stdout: /Command:\s+\/demo-skill/ },
    { alias: 'r', args: ['r', 'other-skill'], stdout: /^\/other-skill$/ },
    { alias: 'fav', args: ['fav', 'other-skill'], stdout: /avorited other-skill/i },
    { alias: 'ls', args: ['ls'], stdout: /other-skill/ },
  ])('alias $alias dispatches the same way as the full command', ({ args, stdout }) => {
    const result = run(args);
    expectSuccess(result);
    expect(result.stdout.trim()).toMatch(stdout);
  });

  it.skipIf(IS_WINDOWS)('alias o opens the entry', () => {
    expectSuccess(run(['o', 'other-skill']));
    expect(readFileSync(box.editorLog, 'utf8')).toContain(join('other-skill', 'SKILL.md'));
  });
});

describe('built CLI: commands without a positional argument', () => {
  it.each([
    { name: 'list', args: ['list'], stdout: /demo-skill/ },
    { name: 'stats', args: ['stats'], stdout: /CommandVault Dashboard/ },
    { name: 'diff', args: ['diff'], stdout: /Baseline snapshot saved|No changes since last/ },
    { name: 'init', args: ['init'], stdout: /CommandVault Init/ },
  ])('$name', ({ args, stdout }) => {
    const result = run(args);
    expectSuccess(result);
    expect(result.stdout, context(result)).toMatch(stdout);
  });

  it('list --json prints every fixture entry as parseable JSON', () => {
    const names = entriesOf(run(['list', '--json'])).map((entry) => entry.name);
    expect(names.sort()).toEqual([...FIXTURE_ENTRY_NAMES].sort());
  });

  it('--help registers exactly the expected commands', () => {
    const result = run(['--help']);
    expectSuccess(result);
    expect(registeredCommands(result.stdout).sort()).toEqual([...SUBCOMMANDS].sort());
  });

  it('--version prints the version from package.json', () => {
    const result = run(['--version']);
    expectSuccess(result);
    const pkg = JSON.parse(readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('doctor runs its checks and exits 0 even when it finds problems', () => {
    const result = run(['doctor']);
    expectSuccess(result);
    expect(result.stdout, context(result)).toMatch(/CommandVault Doctor/);
    expect(result.stdout, context(result)).toMatch(/Node\.js version/);
  });

  it('an unknown command is rejected with a usage error', () => {
    const result = run(['bogus']);
    expect(result.status, context(result)).not.toBe(0);
    expect(result.stderr, context(result)).toMatch(/too many arguments|unknown command/i);
  });
});

describe('built CLI: options reach the real command', () => {
  it('--type filters the listing', () => {
    const entries = entriesOf(run(['list', '--type', 'skill', '--json']));
    expect(entries.map((entry: JsonEntry) => entry.name).sort()).toEqual([
      'demo-skill',
      'other-skill',
    ]);
    expect(entries.every((entry: JsonEntry) => entry.type === 'skill')).toBe(true);
  });

  it('the global --claude-path redirects which config directory is read', () => {
    const names = entriesOf(run(['list', '--json', '--claude-path', box.altClaudeDir])).map(
      (entry) => entry.name,
    );
    expect(names).toEqual(['alt-only-skill']);
  });

  it('--limit caps the number of search results', () => {
    const limited = parseJson<{ results: unknown[] }>(
      run(['search', 'demo', '--limit', '1', '--json']),
    );
    const unlimited = parseJson<{ results: unknown[] }>(run(['search', 'demo', '--json']));
    expect(unlimited.results.length).toBeGreaterThan(1);
    expect(limited.results).toHaveLength(1);
  });

  it('export --type and --pretty filter and indent the written file', () => {
    expectSuccess(run(['export', 'agents.json', '--type', 'agent', '--pretty']));
    const raw = readFileSync(join(box.workDir, 'agents.json'), 'utf8');
    const bundle = JSON.parse(raw) as { totalEntries: number; entries: JsonEntry[] };
    expect(bundle.totalEntries).toBe(1);
    expect(bundle.entries.map((entry) => entry.name)).toEqual(['demo-agent']);
    expect(raw).toContain('\n  "entries"');
  });

  it('audit honours --threshold and --min-score', () => {
    const result = run(['audit', '--threshold', '1', '--min-score', '99']);
    expectSuccess(result);
    expect(result.stdout).toMatch(/not modified in 1\+ days/);
    expect(result.stdout).toMatch(/score < 99/);
  });

  it('backup creates a snapshot that backup --list then names', () => {
    // `backup` copies vault.db, which only exists once some command has opened the vault.
    expectSuccess(run(['list']));
    const created = run(['backup']);
    expectSuccess(created);
    expect(created.stdout, context(created)).toMatch(/Backup created: .*vault-.*\.db/);

    const listed = run(['backup', '--list']);
    expectSuccess(listed);
    expect(listed.stdout, context(listed)).toMatch(/Available backups:[\s\S]*vault-.*\.db/);
  });

  it('import --dry-run previews a bundle without saving it', () => {
    expectSuccess(run(['export', 'bundle.json', '--type', 'agent']));
    const result = run(['import', 'bundle.json', '--dry-run']);
    expectSuccess(result);
    expect(result.stdout).toMatch(/demo-agent/);
    expect(result.stdout).toMatch(/Dry run/);
  });
});

describe('built CLI: commands that forward to subcommands', () => {
  it('config get / set round-trips through the real config file', () => {
    expectNoDispatchFailure(run(['config', 'get']));
    const set = run(['config', 'set', 'searchTier', 'fuse']);
    expectSuccess(set);
    const get = run(['config', 'get', 'searchTier']);
    expect(get.status, context(get)).toBe(0);
    expect(get.stdout).toContain('fuse');
    const file = join(box.home, '.commandvault', 'config.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ searchTier: 'fuse' });
  });

  it('registry add accepts its own --type option, and list and remove see the result', () => {
    const added = run([
      'registry',
      'add',
      'e2e-registry',
      'https://example.com/registry.json',
      '--type',
      'api',
    ]);
    expectSuccess(added);
    expect(added.stdout).toMatch(/e2e-registry.*\(api\)/);

    const listed = run(['registry', 'list']);
    expectSuccess(listed);
    expect(listed.stdout).toMatch(/e2e-registry \(api\)/);

    expectSuccess(run(['registry', 'remove', 'e2e-registry']));
    expect(run(['registry', 'list']).stdout).not.toMatch(/e2e-registry/);
  });
});

describe('built CLI: commands that report user errors cleanly instead of crashing', () => {
  it.each([
    [
      'import of a missing file',
      ['import', join('nope', 'missing.vault.json')],
      /Cannot read file/,
    ],
    [
      'import --dry-run of a missing file',
      ['import', 'missing.vault.json', '--dry-run'],
      /Cannot read file/,
    ],
    [
      'sync of a private address',
      ['sync', 'https://127.0.0.1/registry.json', '--dry-run'],
      /private\/internal URL/,
    ],
    ['restore of a missing backup', ['restore', 'no-such-backup.db'], /Backup file not found/],
  ])('%s', (_name, args, message) => {
    const result = run(args);
    expectNoDispatchFailure(result);
    expect(`${result.stderr}${result.stdout}`, context(result)).toMatch(message);
  });

  // Today these commands print the error and still exit 0 (CV-G2-018, exit-code framework).
  it.todo('exits non-zero after reporting a user error');
});

describe('built CLI: known product gaps the dispatch fix does not cover', () => {
  // `favorite` persists, but Vault.getAllEntries() never merges favorites, so `list` cannot see them.
  it.todo('list --favorites shows entries marked with favorite (CV-G1-004)');
});

describe('built CLI: long-running and interactive entry points really start', () => {
  it('watch initialises the vault and begins watching', async () => {
    const result = await box.runUntil(['watch'], /Watching for changes/, 20_000);
    expectNoDispatchFailure(result);
    expect(result.matched, context(result)).toBe(true);
    expect(result.stderr).toMatch(LOADED_MESSAGE);
  });

  // With no TTY on stdin these take the legacy prompt path whichever of --tui/--no-tui is given, so
  // they prove dispatch and vault start-up, not flag precedence. The prompt waits for input, so
  // the run is stopped once it appears.
  it.each([
    ['interactive --no-tui', ['interactive', '--no-tui']],
    ['bare `vault --no-tui`', ['--no-tui']],
  ])('%s shows the search prompt over the loaded vault', async (_name, args) => {
    const result = await box.runUntil(args, /Search commands/, 20_000);
    expectNoDispatchFailure(result);
    expect(result.matched, context(result)).toBe(true);
    expect(result.stderr, context(result)).toMatch(LOADED_MESSAGE);
  });
});
