import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/**
 * Harness for the end-to-end tests over the BUILT binary (`node dist/index.js`) in a sandboxed HOME.
 * Set COMMANDVAULT_E2E_CLI to test a different entry point, e.g. a packed-and-installed tarball or
 * a deliberately broken copy.
 */

export const CLI =
  process.env['COMMANDVAULT_E2E_CLI'] ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');

export const IS_WINDOWS = process.platform === 'win32';

/** Entries the fixture produces: 2 skills, an agent, a command, a rule and the settings.json hook. */
export const FIXTURE_ENTRY_NAMES = [
  'PreToolUse:Bash:echo hi',
  'demo rule',
  'demo-agent',
  'demo-cmd',
  'demo-skill',
  'other-skill',
];

export const LOADED_MESSAGE = new RegExp(
  `Vault loaded: ${FIXTURE_ENTRY_NAMES.length} entries indexed`,
);

/** Output that means the dispatch layer itself broke, as opposed to a command reporting a user error. */
const DISPATCH_FAILURE =
  /is not a function|TypeError|ReferenceError|Cannot read properties|unknown option|unknown command|too many arguments|missing required argument|argument missing|Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i;

export interface RunResult {
  readonly args: readonly string[];
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface JsonEntry {
  readonly name: string;
  readonly type: string;
}

export interface SandboxOptions {
  /** Point COMMANDVAULT_HOME at a directory that is NOT under the sandbox HOME. */
  readonly separateDataDir?: boolean;
  /** Point CLAUDE_CONFIG_DIR at `altClaudeDir` instead of leaving the default `<home>/.claude`. */
  readonly claudeConfigDirFromEnv?: boolean;
}

export interface Sandbox {
  readonly home: string;
  /** Where the CLI keeps vault.db, config.json and backups for this sandbox. */
  readonly dataDir: string;
  readonly workDir: string;
  /** A second config directory holding one skill that exists nowhere else. */
  readonly altClaudeDir: string;
  /** Receives the arguments the fake $EDITOR was launched with (POSIX only). */
  readonly editorLog: string;
  /** `env` adds to (and overrides) the sandbox environment for this one run. */
  run(args: readonly string[], env?: Readonly<Record<string, string>>): RunResult;
  /**
   * Starts a long-running command and sends `signal` (SIGTERM by default) as soon as `marker`
   * shows up on stdout.
   */
  runUntil(
    args: readonly string[],
    marker: RegExp,
    timeoutMs: number,
    signal?: NodeJS.Signals,
  ): Promise<RunResult & { readonly matched: boolean }>;
  /**
   * Runs a command whose stdout reader has gone away before it writes anything, like
   * `vault completions bash | head -0` after the reader exited.
   */
  runWithClosedStdout(args: readonly string[]): Promise<RunResult>;
  dispose(): void;
}

function putFile(root: string, relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeFixtures(claudeDir: string, altClaudeDir: string): void {
  putFile(
    claudeDir,
    'skills/demo-skill/SKILL.md',
    '---\nname: demo-skill\ndescription: A demo skill for e2e tests\n---\nBody of the demo skill.\n',
  );
  putFile(
    claudeDir,
    'skills/other-skill/SKILL.md',
    '---\nname: other-skill\ndescription: Another skill\n---\nMore text.\n',
  );
  putFile(
    claudeDir,
    'agents/demo-agent.md',
    '---\nname: demo-agent\ndescription: A demo agent\n---\nAgent body.\n',
  );
  putFile(
    claudeDir,
    'commands/demo-cmd.md',
    '---\ndescription: A demo command\n---\nCommand body.\n',
  );
  putFile(claudeDir, 'rules/demo-rule.md', '# Demo rule\nAlways test the built binary.\n');
  putFile(
    claudeDir,
    'settings.json',
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }),
  );
  putFile(claudeDir, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {} }));
  putFile(
    altClaudeDir,
    'skills/alt-only-skill/SKILL.md',
    '---\nname: alt-only-skill\ndescription: Lives only in the alternate config dir\n---\nAlt body.\n',
  );
}

/** `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows; point both at the sandbox. */
function sandboxEnv(
  home: string,
  editorStub: string,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: home,
    USERPROFILE: home,
    EDITOR: editorStub,
    NO_COLOR: '1',
    CI: '1',
    ...extra,
  };
  for (const key of ['SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runToCompletion(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv = {},
): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env, ...extraEnv },
  });
  return {
    args,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function runUntilMarker(
  args: readonly string[],
  marker: RegExp,
  timeoutMs: number,
  signal: NodeJS.Signals,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult & { readonly matched: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let matched = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!matched && marker.test(stdout)) {
        matched = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      child.kill('SIGKILL'); // best effort: the error may come from a failed kill, not a failed spawn
      resolve({ args, status: null, stdout, stderr, error: error.message, matched });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ args, status, stdout, stderr, matched });
    });
  });
}

function runClosedStdout(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    child.stdout.destroy(); // the reader is gone before the child has even started up
    child.stderr.setEncoding('utf8');
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ args, status: null, stdout: '', stderr, error: error.message });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ args, status, stdout: '', stderr });
    });
  });
}

export function createSandbox(options: SandboxOptions = {}): Sandbox {
  if (!existsSync(CLI)) {
    throw new Error(`Built CLI not found at ${CLI}. Run \`pnpm build\` before the e2e tests.`);
  }
  const root = mkdtempSync(join(tmpdir(), 'cv-cli-e2e-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const altClaudeDir = join(root, 'alt-claude');
  const editorLog = join(root, 'editor.log');
  const editorStub = join(root, 'editor.sh');
  mkdirSync(workDir, { recursive: true });

  // A fake $EDITOR that records what it was asked to open, so `open` can be verified end to end.
  writeFileSync(editorStub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${editorLog}'\n`);
  if (!IS_WINDOWS) chmodSync(editorStub, 0o755);
  writeFixtures(join(home, '.claude'), altClaudeDir);

  const dataDir = options.separateDataDir ? join(root, 'data') : join(home, '.commandvault');
  const extraEnv: Record<string, string> = {};
  if (options.separateDataDir) extraEnv['COMMANDVAULT_HOME'] = dataDir;
  if (options.claudeConfigDirFromEnv) extraEnv['CLAUDE_CONFIG_DIR'] = altClaudeDir;

  const env = sandboxEnv(home, editorStub, extraEnv);
  return {
    home,
    dataDir,
    workDir,
    altClaudeDir,
    editorLog,
    run: (args, overrides) => runToCompletion(args, workDir, env, overrides),
    runUntil: (args, marker, timeoutMs, signal = 'SIGTERM') =>
      runUntilMarker(args, marker, timeoutMs, signal, workDir, env),
    runWithClosedStdout: (args) => runClosedStdout(args, workDir, env),
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/** Writes `~/.commandvault/config.json` inside the sandbox; a string is written verbatim. */
export function writeConfigFile(box: Sandbox, config: unknown): void {
  putFile(
    join(box.home, '.commandvault'),
    'config.json',
    typeof config === 'string' ? config : JSON.stringify(config),
  );
}

export function context(result: RunResult): string {
  const error = result.error ? ` (${result.error})` : '';
  return [
    `vault ${result.args.join(' ')} -> status ${result.status}${error}`,
    `stdout: ${result.stdout.slice(0, 600)}`,
    `stderr: ${result.stderr.slice(0, 600)}`,
  ].join('\n');
}

export function expectNoDispatchFailure(result: RunResult): void {
  expect(`${result.stderr}\n${result.stdout}`, context(result)).not.toMatch(DISPATCH_FAILURE);
}

export function expectSuccess(result: RunResult): void {
  expectNoDispatchFailure(result);
  expect(result.status, context(result)).toBe(0);
}

export function parseJson<T>(result: RunResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`stdout is not JSON\n${context(result)}`);
  }
}

export function entriesOf(result: RunResult): JsonEntry[] {
  return parseJson<{ entries: JsonEntry[] }>(result).entries;
}

/** Top-level command names from the "Commands:" rows of `vault --help` (wrapped lines are indented further). */
export function registeredCommands(helpText: string): string[] {
  const rows = (helpText.split('Commands:')[1] ?? '').split('\n').slice(1);
  const names: string[] = [];
  for (const row of rows) {
    if (row.trim() === '') break;
    const match = /^ {2}(\S+)/.exec(row);
    if (match?.[1] && match[1] !== 'help') names.push(match[1].split('|')[0] as string);
  }
  return names;
}
