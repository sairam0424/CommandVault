import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLI, context, createSandbox, parseJson, type RunResult, type Sandbox } from './harness.js';

/**
 * `vault doctor` against the BUILT binary: it must inspect the configuration the other commands
 * use, tell required problems from optional gaps, and exit 1 only when something required fails.
 */

vi.setConfig({ testTimeout: 60_000 });

const EXIT_FAILURE = 1;

interface Check {
  readonly name: string;
  readonly status: 'pass' | 'info' | 'warn' | 'fail';
  readonly detail: string;
}

interface DoctorReport {
  readonly claudeDir: string;
  readonly dataDir: string;
  readonly checks: readonly Check[];
  readonly counts: Readonly<Record<Check['status'], number>>;
}

const cleanups: Array<() => void> = [];

function newBox(options?: Parameters<typeof createSandbox>[0]): Sandbox {
  const box = createSandbox(options);
  cleanups.push(() => box.dispose());
  return box;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Creates vault.db so the data directory exists, the way any earlier command would have. */
function withExistingVault(box: Sandbox): Sandbox {
  const first = box.run(['list', '--json']);
  expect(first.status, context(first)).toBe(0);
  return box;
}

const claudeDirOf = (box: Sandbox): string => join(box.home, '.claude');

function reportOf(result: RunResult): DoctorReport {
  return parseJson<DoctorReport>(result);
}

function checkNamed(report: DoctorReport, name: string): Check {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (check === undefined) {
    throw new Error(`no check named ${name}: ${report.checks.map((c) => c.name).join(', ')}`);
  }
  return check;
}

function doctorLine(result: RunResult, label: string): string {
  const line = result.stdout.split('\n').find((candidate) => candidate.includes(label));
  return line ?? `(no line for ${label})\n${context(result)}`;
}

describe('built CLI: doctor on a healthy fixture', () => {
  it('passes, exits 0 and prints the paths it really inspected', () => {
    const box = withExistingVault(newBox());
    const result = box.run(['doctor']);

    expect(result.status, context(result)).toBe(0);
    expect(result.stdout, context(result)).toContain(claudeDirOf(box));
    expect(result.stdout, context(result)).toContain(box.dataDir);
    expect(result.stdout, context(result)).not.toContain('~/.claude');
    expect(result.stdout, context(result)).not.toContain('~/.commandvault');
    expect(result.stdout, context(result)).not.toContain('✗');
  });

  it('reads the Node floor from the package engines and reports the running version', () => {
    const packageJson = JSON.parse(
      readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8'),
    ) as { engines: { node: string } };
    const result = withExistingVault(newBox()).run(['doctor']);

    const line = doctorLine(result, 'Node.js');
    expect(line, context(result)).toContain(`v${process.versions.node}`);
    expect(line, context(result)).toContain(packageJson.engines.node);
  });

  it('treats an absent optional directory as information, not a failure', () => {
    const box = withExistingVault(newBox());
    rmSync(join(claudeDirOf(box), 'commands'), { recursive: true });
    rmSync(join(claudeDirOf(box), 'plugins'), { recursive: true });

    const result = box.run(['doctor', '--json']);
    const report = reportOf(result);

    expect(result.status, context(result)).toBe(0);
    expect(checkNamed(report, 'commands directory').status).toBe('info');
    expect(checkNamed(report, 'installed_plugins.json').status).toBe('info');
    expect(checkNamed(report, 'Parse problems').detail).toBe('none');
    expect(report.counts.fail).toBe(0);
  });
});

describe('built CLI: doctor --json', () => {
  it('prints exactly one JSON document with the checks and their counts', () => {
    const box = withExistingVault(newBox());
    const result = box.run(['doctor', '--json']);

    expect(result.status, context(result)).toBe(0);
    const report = reportOf(result);
    expect(report.claudeDir).toBe(claudeDirOf(box));
    expect(report.dataDir).toBe(box.dataDir);
    expect(checkNamed(report, 'Database').status).toBe('pass');
    expect(checkNamed(report, 'settings.json').status).toBe('pass');
    expect(report.checks.every((check) => check.detail.length > 0)).toBe(true);
    const tally = report.checks.filter((check) => check.status === 'pass').length;
    expect(report.counts.pass).toBe(tally);
    expect(report.counts.fail).toBe(0);
  });

  it('still prints the document when a required check fails, and exits 1', () => {
    const box = withExistingVault(newBox());
    writeFileSync(join(claudeDirOf(box), 'settings.json'), '{ "hooks": ');

    const result = box.run(['doctor', '--json']);

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    expect(checkNamed(reportOf(result), 'settings.json').status).toBe('fail');
  });
});

describe('built CLI: doctor with a corrupt settings.json', () => {
  it('fails the settings check with the parse error and exits 1', () => {
    const box = withExistingVault(newBox());
    writeFileSync(join(claudeDirOf(box), 'settings.json'), '{ "hooks": ');

    const result = box.run(['doctor']);

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    const line = doctorLine(result, 'settings.json');
    expect(line, context(result)).toContain('✗');
    expect(line, context(result)).toMatch(/not valid JSON/i);
    expect(result.stderr, context(result)).toMatch(/^error: 1 required check failed$/m);
  });

  it('does not let a settings.json that is not an object read as passing', () => {
    const box = withExistingVault(newBox());
    writeFileSync(join(claudeDirOf(box), 'settings.json'), '[1, 2]');

    const result = box.run(['doctor', '--json']);

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    expect(checkNamed(reportOf(result), 'settings.json').status).toBe('fail');
  });
});

describe('built CLI: doctor follows the configuration the other commands use', () => {
  it('inspects --claude-path instead of <HOME>/.claude', () => {
    const box = withExistingVault(newBox());
    rmSync(claudeDirOf(box), { recursive: true });

    const result = box.run(['doctor', '--claude-path', box.altClaudeDir, '--json']);
    const report = reportOf(result);

    expect(result.status, context(result)).toBe(0);
    expect(report.claudeDir).toBe(box.altClaudeDir);
    expect(checkNamed(report, 'Claude directory').detail).toContain(box.altClaudeDir);
    expect(checkNamed(report, 'skills directory').detail).toContain('1 skill');
    expect(checkNamed(report, 'Entries').detail).toContain('1 entry');
  });

  it('inspects the claudeConfigPath stored in config.json', () => {
    const box = withExistingVault(newBox());
    rmSync(claudeDirOf(box), { recursive: true });
    const configPath = join(box.dataDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ claudeConfigPath: box.altClaudeDir }));

    const result = box.run(['doctor', '--json']);

    expect(result.status, context(result)).toBe(0);
    const report = reportOf(result);
    expect(report.claudeDir).toBe(box.altClaudeDir);
    expect(checkNamed(report, 'Entries').detail).toContain('1 entry');
  });

  it('names the redirected directories instead of ~/.claude and ~/.commandvault', () => {
    const box = withExistingVault(newBox({ separateDataDir: true, claudeConfigDirFromEnv: true }));

    const result = box.run(['doctor']);

    expect(result.status, context(result)).toBe(0);
    expect(result.stdout, context(result)).toContain(box.altClaudeDir);
    expect(result.stdout, context(result)).toContain(box.dataDir);
    expect(result.stdout, context(result)).not.toContain('~/.claude');
    expect(result.stdout, context(result)).not.toContain('~/.commandvault');
  });

  it('fails on a missing data directory without creating it', () => {
    const box = newBox();

    const result = box.run(['doctor']);

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    expect(doctorLine(result, 'CommandVault directory'), context(result)).toContain('vault init');
    expect(existsSync(box.dataDir), 'doctor must not create the data directory').toBe(false);
  });
});

describe('built CLI: doctor never changes the user vault', () => {
  const md5 = (path: string): string => createHash('md5').update(readFileSync(path)).digest('hex');
  const dataFiles = (box: Sandbox): string[] => readdirSync(box.dataDir).sort();

  it('keeps the index and its favorites when pointed at an empty directory', () => {
    const box = withExistingVault(newBox());
    const favorited = box.run(['fav', 'other-skill']);
    expect(favorited.status, context(favorited)).toBe(0);
    const database = join(box.dataDir, 'vault.db');
    const before = { hash: md5(database), files: dataFiles(box) };
    const empty = join(box.home, 'empty-claude');
    mkdirSync(empty);

    const result = box.run(['doctor', '--claude-path', empty, '--json']);

    expect(result.status, context(result)).toBe(0);
    expect({ hash: md5(database), files: dataFiles(box) }).toEqual(before);
    const stats = box.run(['stats', '--json']);
    expect(parseJson<{ favoriteCount: number }>(stats).favoriteCount, context(stats)).toBe(1);
  });

  it('fails the Database row for a garbage vault.db and leaves the file where it is', () => {
    const box = withExistingVault(newBox());
    const database = join(box.dataDir, 'vault.db');
    writeFileSync(database, Buffer.alloc(4000, 0x5a));
    const before = { hash: md5(database), files: dataFiles(box) };

    const result = box.run(['doctor', '--json']);

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    const row = checkNamed(reportOf(result), 'Database');
    expect(row.status, context(result)).toBe('fail');
    expect(row.detail).toContain(database);
    expect({ hash: md5(database), files: dataFiles(box) }).toEqual(before);
  });
});

describe('built CLI: doctor when the native SQLite addon cannot load', () => {
  function stubFor(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cv-doctor-abi-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stub = join(dir, 'abi-mismatch.cjs');
    writeFileSync(
      stub,
      [
        'const real = process.dlopen;',
        'process.dlopen = function (module, filename, flags) {',
        '  if (/better_sqlite3\\.node$/.test(filename)) {',
        "    const error = new Error('The module ' + filename + ' was compiled against a different Node.js version using NODE_MODULE_VERSION 1. This version of Node.js requires NODE_MODULE_VERSION ' + process.versions.modules + '.');",
        "    error.code = 'ERR_DLOPEN_FAILED';",
        '    throw error;',
        '  }',
        '  return real.apply(this, arguments);',
        '};',
        '',
      ].join('\n'),
    );
    return stub;
  }

  it('reports one actionable Database row and exits 1 without a raw loader error', () => {
    const box = withExistingVault(newBox());

    const result = box.run(['doctor'], { NODE_OPTIONS: `--require ${stubFor()}` });

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    const databaseRows = result.stdout.split('\n').filter((line) => /better-sqlite3/.test(line));
    expect(databaseRows, context(result)).toHaveLength(1);
    expect(databaseRows[0], context(result)).toContain('✗');
    expect(databaseRows[0], context(result)).toContain('npm rebuild better-sqlite3');
    expect(doctorLine(result, 'Node.js'), context(result)).toContain('✓');
    expect(`${result.stdout}${result.stderr}`, context(result)).not.toMatch(/ERR_DLOPEN_FAILED/);
    expect(result.stderr, context(result)).not.toMatch(/^\s+at /m);
  });

  it('reports the same single row under --json', () => {
    const box = withExistingVault(newBox());

    const result = box.run(['doctor', '--json'], { NODE_OPTIONS: `--require ${stubFor()}` });

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    const database = checkNamed(reportOf(result), 'Database');
    expect(database.status).toBe('fail');
    expect(database.detail).toContain('better-sqlite3');
  });
});
