import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  IS_WINDOWS,
  context,
  createSandbox,
  entriesOf,
  writeConfigFile,
  type RunResult,
  type Sandbox,
} from './harness.js';

/**
 * Config writes are validated and never destroy a config.json; the global options reach every
 * entry point (default action, `interactive`, `watch`); `help` works. All against the BUILT binary.
 */

vi.setConfig({ testTimeout: 60_000 });

const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const VALID_KEYS = 'claudeConfigPath, searchTier, enableWatcher, projectPaths';

const boxes: Sandbox[] = [];

function newBox(): Sandbox {
  const box = createSandbox();
  boxes.push(box);
  return box;
}

afterEach(() => {
  for (const box of boxes.splice(0)) box.dispose();
});

const configPathOf = (box: Sandbox): string => join(box.home, '.commandvault', 'config.json');

function errorLines(result: RunResult): string[] {
  return result.stderr.split('\n').filter((line) => line.startsWith('error:'));
}

function expectFailure(result: RunResult, status: number, message: RegExp): void {
  expect(result.status, context(result)).toBe(status);
  expect(errorLines(result), context(result)).toHaveLength(1);
  expect(result.stderr, context(result)).toMatch(message);
  expect(result.stdout, context(result)).toBe('');
  expect(result.stderr, context(result)).not.toMatch(/^\s+at /m);
}

describe('built CLI: config set validates before it writes', () => {
  it('rejects a searchTier outside the tier list, exits 2 and creates nothing', () => {
    const box = newBox();
    const result = box.run(['config', 'set', 'searchTier', 'bogus']);
    expectFailure(
      result,
      EXIT_USAGE,
      /^error: invalid searchTier "bogus" \(expected sqlite, minisearch or fuse\)/m,
    );
    expect(existsSync(configPathOf(box)), 'nothing was written').toBe(false);
    // The bad value must not have poisoned every other command (the bug this guards against).
    expect(box.run(['list', '--json']).status).toBe(0);
  });

  it('rejects an unknown key and lists the valid ones', () => {
    const box = newBox();
    const result = box.run(['config', 'set', 'searchTeir', 'fuse']);
    expectFailure(
      result,
      EXIT_USAGE,
      new RegExp(`^error: unknown config key "searchTeir" \\(valid keys: ${VALID_KEYS}\\)`, 'm'),
    );
    expect(existsSync(configPathOf(box))).toBe(false);
  });

  it('rejects a dotted key, since the schema has no nested settings', () => {
    const result = newBox().run(['config', 'set', 'searchTier.mode', 'fuse']);
    expectFailure(result, EXIT_USAGE, /^error: unknown config key "searchTier\.mode"/m);
  });

  it.each(['yes', '1', 'True', ''])('rejects enableWatcher=%j (only true or false)', (value) => {
    const result = newBox().run(['config', 'set', 'enableWatcher', value]);
    expectFailure(
      result,
      EXIT_USAGE,
      /^error: invalid enableWatcher .*\(expected true or false\)/m,
    );
  });

  it('rejects projectPaths that is not a JSON array of strings', () => {
    const box = newBox();
    expectFailure(
      box.run(['config', 'set', 'projectPaths', '/a/b']),
      EXIT_USAGE,
      /^error: projectPaths must be a JSON array of strings/m,
    );
    expectFailure(
      box.run(['config', 'set', 'projectPaths', '[1,2]']),
      EXIT_USAGE,
      /^error: projectPaths must be a JSON array of strings/m,
    );
  });

  it('rejects an empty claudeConfigPath', () => {
    const result = newBox().run(['config', 'set', 'claudeConfigPath', '']);
    expectFailure(result, EXIT_USAGE, /^error: claudeConfigPath must not be empty/m);
  });

  it('stores valid values with their real types', () => {
    const box = newBox();
    expect(box.run(['config', 'set', 'searchTier', 'fuse']).status).toBe(0);
    expect(box.run(['config', 'set', 'enableWatcher', 'false']).status).toBe(0);
    expect(box.run(['config', 'set', 'projectPaths', '["/a","/b"]']).status).toBe(0);
    expect(JSON.parse(readFileSync(configPathOf(box), 'utf8'))).toEqual({
      searchTier: 'fuse',
      enableWatcher: false,
      projectPaths: ['/a', '/b'],
    });
  });

  it('keeps a numeric-looking claudeConfigPath a string and only warns when it is missing', () => {
    const box = newBox();
    const result = box.run(['config', 'set', 'claudeConfigPath', '12345']);
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout).toContain('Set claudeConfigPath = "12345"');
    expect(result.stderr, context(result)).toMatch(/Warning: .*12345.* does not exist/);
    expect(JSON.parse(readFileSync(configPathOf(box), 'utf8'))).toEqual({
      claudeConfigPath: '12345',
    });
  });

  it('does not warn for a claudeConfigPath that exists', () => {
    const box = newBox();
    const result = box.run(['config', 'set', 'claudeConfigPath', box.altClaudeDir]);
    expect(result.status, context(result)).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('preserves every other key, including ones it does not manage', () => {
    const box = newBox();
    writeConfigFile(box, {
      searchTier: 'fuse',
      registries: [{ name: 'r', url: 'https://example.com/r.json', type: 'json' }],
      somethingNew: { nested: true },
    });
    expect(box.run(['config', 'set', 'enableWatcher', 'false']).status).toBe(0);
    expect(JSON.parse(readFileSync(configPathOf(box), 'utf8'))).toEqual({
      searchTier: 'fuse',
      registries: [{ name: 'r', url: 'https://example.com/r.json', type: 'json' }],
      somethingNew: { nested: true },
      enableWatcher: false,
    });
  });

  it('repairs a bad searchTier that an older build let through', () => {
    const box = newBox();
    writeConfigFile(box, { searchTier: 'bogus' });
    expect(box.run(['list']).status, 'the bad file breaks every command').toBe(EXIT_USAGE);
    const fixed = box.run(['config', 'set', 'searchTier', 'fuse']);
    expect(fixed.status, context(fixed)).toBe(0);
    expect(box.run(['list', '--json']).status).toBe(0);
  });

  it('refuses to write a document that would stay invalid', () => {
    const box = newBox();
    writeConfigFile(box, { searchTier: 'bogus' });
    const before = readFileSync(configPathOf(box));
    const result = box.run(['config', 'set', 'enableWatcher', 'true']);
    expectFailure(result, EXIT_USAGE, /^error: invalid searchTier "bogus" in .*config\.json/m);
    expect(readFileSync(configPathOf(box)).equals(before)).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('creates a missing config with mode 0600 in a 0700 data directory', () => {
    const box = newBox();
    expect(box.run(['config', 'set', 'searchTier', 'fuse']).status).toBe(0);
    expect(statSync(configPathOf(box)).mode & 0o777).toBe(0o600);
    expect(statSync(join(box.home, '.commandvault')).mode & 0o777).toBe(0o700);
  });

  it('a second config set rewrites the file and leaves no temp file behind', () => {
    const box = newBox();
    expect(box.run(['config', 'set', 'searchTier', 'fuse']).status).toBe(0);
    expect(box.run(['config', 'set', 'enableWatcher', 'true']).status).toBe(0);
    expect(JSON.parse(readFileSync(configPathOf(box), 'utf8'))).toEqual({
      searchTier: 'fuse',
      enableWatcher: true,
    });
    expect(readdirSync(join(box.home, '.commandvault')).filter((n) => n.endsWith('.tmp'))).toEqual(
      [],
    );
  });
});

describe('built CLI: a malformed config.json is never overwritten', () => {
  const MALFORMED = [
    ['invalid JSON', '{"searchTier": "fuse", "enableWatcher": tru'],
    ['an empty file', ''],
    ['a JSON array', '["searchTier","fuse"]'],
    ['a JSON scalar', '42'],
  ] as const;

  it.each(MALFORMED)('config set on %s exits 1 and leaves the bytes alone', (_name, content) => {
    const box = newBox();
    writeConfigFile(box, content);
    const result = box.run(['config', 'set', 'searchTier', 'fuse']);
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(errorLines(result), context(result)).toHaveLength(1);
    expect(result.stderr, context(result)).toContain(configPathOf(box));
    expect(result.stdout, context(result)).toBe('');
    expect(readFileSync(configPathOf(box), 'utf8')).toBe(content);
  });

  it('names the parse error', () => {
    const box = newBox();
    writeConfigFile(box, '{"searchTier": ');
    const result = box.run(['config', 'set', 'searchTier', 'fuse']);
    expect(result.stderr, context(result)).toMatch(/^error: malformed .*config\.json: .*JSON/m);
  });

  it.each(MALFORMED)('config get on %s fails instead of printing {}', (_name, content) => {
    const box = newBox();
    writeConfigFile(box, content);
    const result = box.run(['config', 'get']);
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(result.stdout, context(result)).toBe('');
  });

  it('registry add leaves a malformed config alone too', () => {
    const box = newBox();
    writeConfigFile(box, '{bad');
    const result = box.run(['registry', 'add', 'foo', 'https://example.com/r.json']);
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(readFileSync(configPathOf(box), 'utf8')).toBe('{bad');
  });

  it.each([
    ['remove', ['registry', 'remove', 'foo']],
    ['list', ['registry', 'list']],
  ])('registry %s reports a malformed config instead of pretending it is empty', (_name, args) => {
    const box = newBox();
    writeConfigFile(box, '{bad');
    const result = box.run(args);
    expect(result.status, context(result)).toBe(EXIT_RUNTIME);
    expect(result.stderr, context(result)).toMatch(/^error: malformed config file .*config\.json/m);
    expect(readFileSync(configPathOf(box), 'utf8')).toBe('{bad');
  });

  // A write-only file cannot be read, but it CAN be written: swallowing the read error would
  // replace the user's settings with a fresh document.
  it.skipIf(IS_WINDOWS || process.getuid?.() === 0)(
    'does not overwrite a file it cannot read',
    () => {
      const box = newBox();
      writeConfigFile(box, { searchTier: 'fuse' });
      chmodSync(configPathOf(box), 0o200);
      try {
        const result = box.run(['config', 'set', 'enableWatcher', 'true']);
        expect(result.status, context(result)).toBe(EXIT_RUNTIME);
        expect(result.stderr, context(result)).toMatch(
          /^error: cannot read config file .*config\.json/m,
        );
      } finally {
        chmodSync(configPathOf(box), 0o600);
      }
      expect(JSON.parse(readFileSync(configPathOf(box), 'utf8'))).toEqual({ searchTier: 'fuse' });
    },
  );
});

describe('built CLI: read commands survive a config.json that is not a JSON object', () => {
  it.each([['null'], ['42'], ['["searchTier","fuse"]']])(
    'list --json with %s warns on stderr and still lists the entries',
    (content) => {
      const box = newBox();
      writeConfigFile(box, content);
      const result = box.run(['list', '--json']);
      expect(result.status, context(result)).toBe(0);
      expect(result.stderr, context(result)).toMatch(/not a JSON object/);
      expect(result.stderr, context(result)).not.toMatch(/Cannot read properties/);
      expect(entriesOf(result).length, context(result)).toBeGreaterThan(0);
    },
  );
});

describe('built CLI: registry add validates --type and the help is real', () => {
  it('rejects a registry type outside json|api, exits 2 and writes nothing', () => {
    const box = newBox();
    const result = box.run([
      'registry',
      'add',
      'foo',
      'https://example.com/r.json',
      '--type',
      'bogus',
    ]);
    expectFailure(result, EXIT_USAGE, /^error: invalid --type "bogus" \(expected json or api\)/m);
    expect(existsSync(configPathOf(box))).toBe(false);
  });

  it('still forwards --type api to the stored registry', () => {
    const box = newBox();
    const added = box.run([
      'registry',
      'add',
      'foo',
      'https://example.com/r.json',
      '--type',
      'api',
    ]);
    expect(added.status, context(added)).toBe(0);
    expect(JSON.parse(readFileSync(configPathOf(box), 'utf8')).registries).toEqual([
      { name: 'foo', url: 'https://example.com/r.json', type: 'api' },
    ]);
  });

  it.each([
    [
      'registry --help',
      ['registry', '--help'],
      [
        /^ {2}add \[options\] <name> <url>/m,
        /^ {2}remove <name>/m,
        /^ {2}list/m,
        /^ {2}search \[options\] <query>/m,
      ],
    ],
    [
      'registry add --help',
      ['registry', 'add', '--help'],
      [/--type <type>\s+Registry type \(json\|api\)/, /Usage: vault registry add/],
    ],
    ['registry search --help', ['registry', 'search', '--help'], [/--limit <n>/]],
    ['config --help', ['config', '--help'], [/^ {2}get \[key\]/m, /^ {2}set <key> <value>/m]],
    [
      'config set --help',
      ['config', 'set', '--help'],
      [/Usage: vault config set \[options\] <key> <value>/],
    ],
  ])('%s shows the real subcommands and options', (_name, args, patterns) => {
    const result = newBox().run(args);
    expect(result.status, context(result)).toBe(0);
    expect(result.stderr, context(result)).toBe('');
    for (const pattern of patterns) expect(result.stdout, context(result)).toMatch(pattern);
    expect(result.stdout, 'the placeholder [args...] is gone').not.toMatch(/\[args\.\.\.\]/);
  });
});

describe('built CLI: help', () => {
  it.each([
    ['help', ['help'], /^Usage: vault \[options\] \[command\]/m],
    ['help list', ['help', 'list'], /^Usage: vault list\|ls \[options\]/m],
    ['help config', ['help', 'config'], /^Usage: vault config \[options\] \[command\]/m],
  ])('%s prints help and exits 0', (_name, args, usage) => {
    const result = newBox().run(args);
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout, context(result)).toMatch(usage);
    expect(result.stderr, context(result)).toBe('');
  });

  it('lists the global options, including --project', () => {
    const result = newBox().run(['--help']);
    expect(result.status, context(result)).toBe(0);
    expect(result.stdout).toMatch(/--project \[dir\]/);
    expect(result.stdout).toMatch(/--claude-path <path>/);
  });

  it('an unknown command is still a usage error', () => {
    const result = newBox().run(['help', 'nonsense']);
    expect(result.status, context(result)).toBe(EXIT_USAGE);
  });
});

describe('built CLI: global options reach the default action and interactive', () => {
  // The legacy prompt cannot be answered (stdin is at EOF), so each run fails after the vault has
  // loaded; the spinner line on stderr says how many entries THAT vault indexed. The fixture
  // config directory holds 6 entries, the alternate one holds exactly 1.
  const ALT_LOADED = /Vault loaded: 1 entries indexed/;
  const DEFAULT_LOADED = /Vault loaded: 6 entries indexed/;

  it.each([
    ['the default action, option first', (alt: string) => ['--claude-path', alt, '--no-tui']],
    ['the default action, option last', (alt: string) => ['--no-tui', '--claude-path', alt]],
    [
      'interactive, option after',
      (alt: string) => ['interactive', '--no-tui', '--claude-path', alt],
    ],
    [
      'interactive, option before',
      (alt: string) => ['--claude-path', alt, 'interactive', '--no-tui'],
    ],
    ['the i alias', (alt: string) => ['i', '--no-tui', '--claude-path', alt]],
  ])('--claude-path is honoured by %s', (_name, build) => {
    const box = newBox();
    const result = box.run(build(box.altClaudeDir));
    expect(result.stderr, context(result)).toMatch(ALT_LOADED);
    expect(result.stderr, context(result)).not.toMatch(DEFAULT_LOADED);
  });

  it('a claudeConfigPath in config.json is still honoured by the default action', () => {
    const box = newBox();
    writeConfigFile(box, { claudeConfigPath: box.altClaudeDir });
    const result = box.run(['--no-tui']);
    expect(result.stderr, context(result)).toMatch(ALT_LOADED);
  });

  it('--tui after the subcommand is not swallowed by the root program', () => {
    const box = newBox();
    // Without a terminal the legacy mode is the default; forcing the TUI announces itself with a
    // different spinner line ("entries", not "entries indexed").
    const result = box.run(['interactive', '--tui']);
    expect(result.stderr, context(result)).toMatch(/Vault loaded: 6 entries(?! indexed)/);
  });

  it('--tui before the subcommand works as well', () => {
    const result = newBox().run(['--tui', 'interactive']);
    expect(result.stderr, context(result)).toMatch(/Vault loaded: 6 entries(?! indexed)/);
  });

  it('--tier is validated on both entry points', () => {
    const box = newBox();
    for (const args of [
      ['interactive', '--tier', 'bogus'],
      ['--tier', 'bogus'],
    ]) {
      expectFailure(box.run(args), EXIT_USAGE, /^error: invalid --tier "bogus"/m);
    }
  });
});

describe('built CLI: --project', () => {
  it('scans a directory that exists, before or after the command', () => {
    const box = newBox();
    const project = join(box.workDir, 'proj');
    mkdirSync(project);
    const after = box.run(['list', '--json', '--project', project]);
    const before = box.run(['--project', project, 'list', '--json']);
    expect(after.status, context(after)).toBe(0);
    expect(before.status, context(before)).toBe(0);
    expect(entriesOf(after).length).toBe(entriesOf(before).length);
  });

  it('a bare --project means the current directory', () => {
    const result = newBox().run(['list', '--json', '--project']);
    expect(result.status, context(result)).toBe(0);
  });

  it('rejects a directory that does not exist, with a hint for the bare form', () => {
    const box = newBox();
    const result = box.run(['--project', 'list']);
    expectFailure(result, EXIT_USAGE, /^error: --project "list" does not exist/m);
    expect(result.stderr, context(result)).toMatch(/^hint: .*--project=<dir>/m);
  });

  it('rejects a file', () => {
    const box = newBox();
    const file = join(box.workDir, 'f.txt');
    writeFileSync(file, 'x');
    expectFailure(
      box.run(['list', '--project', file]),
      EXIT_USAGE,
      /^error: --project ".*f\.txt" is not a directory/m,
    );
  });

  it('is documented in the help text', () => {
    const result = newBox().run(['--help']);
    expect(result.stdout).toMatch(/--project \[dir\]\s+Also scan a project directory/);
  });
});

describe('built CLI: watch honours config.json like every other command', () => {
  const STARTED = /Watching for changes/;

  it.skipIf(IS_WINDOWS)('reads claudeConfigPath from config.json', async () => {
    const box = newBox();
    writeConfigFile(box, { claudeConfigPath: box.altClaudeDir });
    const result = await box.runUntil(['watch'], STARTED, 20_000);
    expect(result.matched, context(result)).toBe(true);
    expect(result.stderr, context(result)).toMatch(/Vault loaded: 1 entries indexed/);
  });

  it.skipIf(IS_WINDOWS)(
    'rejects an invalid searchTier in config.json instead of starting',
    async () => {
      const box = newBox();
      writeConfigFile(box, { searchTier: 'bogus' });
      const result = await box.runUntil(['watch'], STARTED, 20_000);
      expect(result.matched, 'the watcher must never start').toBe(false);
      expect(result.status, context(result)).toBe(EXIT_USAGE);
      expect(result.stderr, context(result)).toMatch(/^error: invalid searchTier "bogus"/m);
    },
  );

  it.skipIf(IS_WINDOWS)('the --claude-path flag still beats the config file', async () => {
    const box = newBox();
    writeConfigFile(box, { claudeConfigPath: box.altClaudeDir });
    const result = await box.runUntil(
      ['watch', '--claude-path', join(box.home, '.claude')],
      STARTED,
      20_000,
    );
    expect(result.stderr, context(result)).toMatch(/Vault loaded: 6 entries indexed/);
  });
});
