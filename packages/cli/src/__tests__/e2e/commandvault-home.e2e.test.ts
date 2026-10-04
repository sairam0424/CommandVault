import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_ENTRY_NAMES,
  context,
  createSandbox,
  entriesOf,
  expectSuccess,
  type Sandbox,
} from './harness.js';

/**
 * COMMANDVAULT_HOME and CLAUDE_CONFIG_DIR over the BUILT binary. Every command used to compute
 * `join(homedir(), '.commandvault')` into a module-level constant, so the variable was ignored
 * (CV-G2-094) and a run with a different data directory still wrote into HOME.
 */

vi.setConfig({ testTimeout: 60_000 });

const names = (sandbox: Sandbox, args: readonly string[]): string[] =>
  entriesOf(sandbox.run(args))
    .map((entry) => entry.name)
    .sort();

/** The directory `vault init` reports under "Scanned:". */
const scannedDir = (stdout: string): string | undefined =>
  /Scanned:\s+(.+)/.exec(stdout)?.[1]?.trim();

describe('built CLI: COMMANDVAULT_HOME relocates every state file', () => {
  let box: Sandbox;
  let homeDataDir: string;

  beforeAll(() => {
    box = createSandbox({ separateDataDir: true });
    homeDataDir = join(box.home, '.commandvault');
  });

  afterAll(() => {
    box?.dispose();
  });

  it('init, config set and registry add write config.json under COMMANDVAULT_HOME', () => {
    const init = box.run(['init']);
    expectSuccess(init);
    expect(init.stdout, context(init)).toContain(join(box.dataDir, 'vault.db'));
    expect(scannedDir(init.stdout), context(init)).toBe(join(box.home, '.claude'));
    expectSuccess(box.run(['config', 'set', 'searchTier', 'fuse']));
    expectSuccess(box.run(['registry', 'add', 'home-registry', 'https://example.com/r.json']));
    const listed = box.run(['registry', 'list']);
    expectSuccess(listed);
    expect(listed.stdout, context(listed)).toContain('home-registry');

    const file = join(box.dataDir, 'config.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      claudeConfigPath: '~/.claude',
      searchTier: 'fuse',
      registries: [{ name: 'home-registry' }],
    });
    expect(existsSync(homeDataDir)).toBe(false);
  });

  it('config get reads the file that config set wrote under COMMANDVAULT_HOME', () => {
    expectSuccess(box.run(['config', 'set', 'searchTier', 'minisearch']));
    const result = box.run(['config', 'get', 'searchTier']);
    expectSuccess(result);
    expect(result.stdout, context(result)).toContain('minisearch');
    expect(existsSync(homeDataDir)).toBe(false);
  });

  it('list creates vault.db there and backup and restore operate on it', () => {
    expectSuccess(box.run(['list']));
    expect(existsSync(join(box.dataDir, 'vault.db'))).toBe(true);

    const created = box.run(['backup']);
    expectSuccess(created);
    expect(created.stdout, context(created)).toContain(join(box.dataDir, 'backups'));
    const backups = readdirSync(join(box.dataDir, 'backups'));
    expect(backups).toHaveLength(1);

    const restored = box.run(['restore', backups[0] as string]);
    expectSuccess(restored);
    expect(restored.stdout, context(restored)).toContain('Database restored from');
    expect(restored.stdout, context(restored)).toContain(join(box.dataDir, 'backups'));
    expect(existsSync(homeDataDir)).toBe(false);
  });
});

describe('built CLI: backup --list and pruning use the backups under COMMANDVAULT_HOME', () => {
  let box: Sandbox;
  let backupDir: string;

  beforeAll(() => {
    box = createSandbox({ separateDataDir: true });
    backupDir = join(box.dataDir, 'backups');
    expectSuccess(box.run(['list']));
  });

  afterAll(() => {
    box?.dispose();
  });

  it('--list shows the backup that `backup` wrote there', () => {
    expectSuccess(box.run(['backup']));
    const [created] = readdirSync(backupDir);

    const listed = box.run(['backup', '--list']);

    expectSuccess(listed);
    expect(listed.stdout, context(listed)).toContain(created as string);
    expect(existsSync(join(box.home, '.commandvault'))).toBe(false);
  });

  it('keeps the newest ten and deletes the oldest in that directory', () => {
    // Backup names have one-second granularity, so seed the old ones instead of running `backup` 11 times.
    const seeded = Array.from(
      { length: 11 },
      (_, day) => `vault-2001-01-${String(day + 1).padStart(2, '0')}T00-00-00.db`,
    );
    for (const name of seeded) writeFileSync(join(backupDir, name), 'old');

    const result = box.run(['backup']);

    expectSuccess(result);
    expect(result.stdout, context(result)).toMatch(/Pruned \d+ old backup/);
    const kept = readdirSync(backupDir).sort();
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain(seeded[0]);
    expect(kept).toContain(seeded[10]);
    expect(existsSync(join(box.home, '.commandvault'))).toBe(false);
  });
});

describe('built CLI: doctor looks for the data directory where COMMANDVAULT_HOME says', () => {
  it('passes the directory and database checks although <HOME>/.commandvault does not exist', () => {
    const box = createSandbox({ separateDataDir: true });
    try {
      mkdirSync(box.dataDir, { recursive: true });
      writeFileSync(join(box.dataDir, 'vault.db'), '');

      const result = box.run(['doctor']);

      expectSuccess(result);
      // No failing check may mention the data directory or the database; the label text is not pinned.
      expect(result.stdout, context(result)).toMatch(/CommandVault Doctor/);
      expect(result.stdout, context(result)).not.toMatch(/✗[^\n]*commandvault/i);
    } finally {
      box.dispose();
    }
  });
});

describe('built CLI: without COMMANDVAULT_HOME the data directory stays under HOME', () => {
  let box: Sandbox;

  beforeAll(() => {
    box = createSandbox();
  });

  afterAll(() => {
    box?.dispose();
  });

  it('init, list and backup use <HOME>/.commandvault', () => {
    expect(box.dataDir).toBe(join(box.home, '.commandvault'));
    expectSuccess(box.run(['init']));
    expectSuccess(box.run(['list']));
    expectSuccess(box.run(['backup']));

    expect(existsSync(join(box.dataDir, 'config.json'))).toBe(true);
    expect(existsSync(join(box.dataDir, 'vault.db'))).toBe(true);
    expect(readdirSync(join(box.dataDir, 'backups'))).toHaveLength(1);
  });
});

describe('built CLI: precedence of the Claude directory', () => {
  it('a claudeConfigPath in config.json wins over CLAUDE_CONFIG_DIR', () => {
    const box = createSandbox({ claudeConfigDirFromEnv: true });
    try {
      expect(names(box, ['list', '--json'])).toEqual(['alt-only-skill']);
      expectSuccess(box.run(['config', 'set', 'claudeConfigPath', join(box.home, '.claude')]));

      expect(names(box, ['list', '--json'])).toEqual([...FIXTURE_ENTRY_NAMES].sort());
    } finally {
      box.dispose();
    }
  });
});

describe('built CLI: CLAUDE_CONFIG_DIR is the default Claude directory', () => {
  let box: Sandbox;

  beforeAll(() => {
    box = createSandbox({ claudeConfigDirFromEnv: true });
  });

  afterAll(() => {
    box?.dispose();
  });

  it('list scans it instead of <HOME>/.claude', () => {
    expect(names(box, ['list', '--json'])).toEqual(['alt-only-skill']);
  });

  it('an explicit --claude-path still wins over the variable', () => {
    const explicit = join(box.home, '.claude');
    expect(names(box, ['list', '--json', '--claude-path', explicit])).toEqual(
      [...FIXTURE_ENTRY_NAMES].sort(),
    );
  });

  it('doctor inspects it instead of <HOME>/.claude', () => {
    const result = box.run(['doctor']);
    expectSuccess(result);
    // The alternate directory holds one skill; <HOME>/.claude holds two.
    expect(result.stdout, context(result)).toMatch(/\b1 skill found/);
  });

  it('init reports it and records no claudeConfigPath that would outrank a later value', () => {
    const init = box.run(['init']);
    expectSuccess(init);
    expect(scannedDir(init.stdout), context(init)).toBe(box.altClaudeDir);

    // A claudeConfigPath in config.json beats the variable, so a recorded one would freeze the
    // profile the variable pointed at on the day of `init` and ignore every later value.
    const config = JSON.parse(readFileSync(join(box.dataDir, 'config.json'), 'utf8'));
    expect(config).not.toHaveProperty('claudeConfigPath');
    expect(config).toMatchObject({ searchTier: 'minisearch' });

    const otherProfile = { CLAUDE_CONFIG_DIR: join(box.home, '.claude') };
    expect(names(box, ['list', '--json'])).toEqual(['alt-only-skill']);
    expect(
      entriesOf(box.run(['list', '--json'], otherProfile))
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...FIXTURE_ENTRY_NAMES].sort());
  });
});
