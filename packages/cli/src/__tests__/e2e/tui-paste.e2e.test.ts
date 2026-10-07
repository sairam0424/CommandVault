import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI,
  IS_WINDOWS,
  createSandbox,
  expectSuccess,
  parseJson,
  type Sandbox,
} from './harness.js';

/**
 * The TUI of the BUILT binary inside a real pseudo-terminal, driven by pty-driver.py: a paste of
 * 150 lines (bracketed and raw, the first line naming the fixture entries), 4 KB of random bytes
 * and a locked database must leave the TUI responsive, acting on no entry, and Ctrl+C must still
 * quit it within two seconds.
 */

vi.setConfig({ testTimeout: 90_000 });

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), 'pty-driver.py');
const PYTHON = 'python3';
const ROWS = 40;
const COLS = 120;
const FAST_MS = 2000;
const DRIVER_DEADLINE_S = 60;
const RANDOM_SEEDS = [1, 2, 3];
const LOCK_HOLD_S = 30;
const LOCK_MESSAGE_WITHIN_MS = 25_000;
const LOCK_DEADLINE_S = 80;
const RUN_SLOW = process.env['COMMANDVAULT_E2E_SLOW'] === '1';
// A crash of the TUI shows up as a stack trace in the terminal output.
const CRASH_OUTPUT = /TypeError|Error:|^\s+at /m;
// The coloured body of pty-driver.py as one line of text: every escape sequence dropped whole.
const COLOURED_PASTE_AS_TEXT = 'demo bold match yellow third line fourth line';
// Clipboard text pasted raw that itself carries a marker pair, then a CR and a Ctrl+F (see the
// driver): a terminal without bracketed paste sends it as is, Ink emits the pair's body as a paste
// and the bytes after it as keys in the same read. Every byte of it was pasted: nothing may act,
// whether or not a line comes before the pair. The pasted text names the fixture entries, so a CR
// or a Ctrl+F that fired as a key would copy and favorite a selected entry, which is asserted.
const EMBEDDED_MARKER_PASTES = [
  { scenario: 'paste-raw-embedded-markers', shown: 'demo x' },
  { scenario: 'paste-embedded-markers-then-keys', shown: 'demo' },
] as const;

interface PtyResult {
  readonly scenario: string;
  readonly ready_ms: number | null;
  readonly write_ms?: number;
  readonly frame_update_ms?: number | null;
  /** The search box text of the last frame, for the paste scenarios. */
  readonly query_line?: string | null;
  readonly ctrl_c_to_exit_ms?: number;
  readonly exited_before_ctrl_c?: boolean;
  readonly exit_status: number | null;
  readonly clip_invocations: number;
  readonly saw_2004h: boolean;
  readonly saw_2004l: boolean;
  readonly output_tail: string;
  readonly lock_acquired_ms?: number;
  readonly message_ms?: number | null;
  readonly error?: string;
}

function hasPythonPty(): boolean {
  return spawnSync(PYTHON, ['-I', '-c', 'import pty'], { encoding: 'utf8' }).status === 0;
}

const skipReason = IS_WINDOWS
  ? "python's pty module is POSIX-only"
  : hasPythonPty()
    ? null
    : 'python3 with pty not on PATH';

let box: Sandbox;

beforeEach(() => {
  box = createSandbox();
});

afterEach(() => {
  box.dispose();
});

function drive(scenario: string, extra: readonly string[] = [], deadlineS = DRIVER_DEADLINE_S) {
  const root = dirname(box.home);
  const envFile = join(root, 'pty-env.json');
  writeFileSync(envFile, JSON.stringify(box.env));
  const args = [
    '-I',
    DRIVER,
    scenario,
    '--node',
    process.execPath,
    '--cli',
    CLI,
    '--env-file',
    envFile,
    '--clip-log',
    join(root, 'clip.log'),
    '--rows',
    String(ROWS),
    '--cols',
    String(COLS),
    '--deadline',
    String(deadlineS),
    ...extra,
  ];
  const run = spawnSync(PYTHON, args, { encoding: 'utf8', timeout: (deadlineS + 10) * 1000 });
  const lastLine = run.stdout.trim().split('\n').at(-1) ?? '';
  let result: PtyResult;
  try {
    result = JSON.parse(lastLine) as PtyResult;
  } catch {
    throw new Error(
      `pty driver returned no JSON (status ${run.status})\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
  }
  // The JSON line is the evidence the report quotes.
  console.log(`[pty ${scenario}] ${lastLine}`);
  return result;
}

interface StoredHits {
  readonly results: readonly { readonly entry: { usageCount: number; favorite: boolean } }[];
}

/** What the vault stores for every entry the query `demo` finds, read back through the CLI. */
function storedHits(): StoredHits['results'] {
  const result = box.run(['search', 'demo', '--tier', 'sqlite', '--json']);
  expectSuccess(result);
  return parseJson<StoredHits>(result).results;
}

/** Usage counts the vault stored, summed over every entry the query `demo` finds. */
function recordedUsage(): number {
  return storedHits().reduce((sum, hit) => sum + hit.entry.usageCount, 0);
}

/** How many of the entries the query `demo` finds the vault stores as favorites. */
function favoritesStored(): number {
  return storedHits().filter((hit) => hit.entry.favorite).length;
}

function expectPasteHandledAsText(result: PtyResult): void {
  const info = JSON.stringify(result);
  expect(result.error, info).toBeUndefined();
  expect(result.frame_update_ms, info).not.toBeNull();
  expect(result.frame_update_ms ?? Infinity, info).toBeLessThan(FAST_MS);
  expect(result.ctrl_c_to_exit_ms, info).toBeLessThan(FAST_MS);
  expect(result.exit_status, info).toBe(0);
  expect(result.clip_invocations, info).toBe(0);
  expect(result.saw_2004h && result.saw_2004l, `bracketed paste on and off: ${info}`).toBe(true);
  expect(recordedUsage(), info).toBe(0);
}

describe.skipIf(skipReason !== null)(
  `vault interactive --tui in a real pty${skipReason ? ` (skipped: ${skipReason})` : ''}`,
  () => {
    it('inserts a 150-line bracketed paste as text and acts on no entry', () => {
      expectPasteHandledAsText(drive('paste-bracketed'));
    });

    // Ink flushes a start marker whose bytes arrive more than 20 ms apart as the text "[20", then
    // hands "0~" and the body over as plain keys, whose one newline would be Enter: a slow link or
    // a scripted writer breaks a marker so. The body is one short line so the box shows it whole.
    it('inserts a bracketed paste whose start marker arrived in two reads as text', () => {
      const result = drive('paste-split-start-marker');
      expectPasteHandledAsText(result);
      expect(result.query_line, JSON.stringify(result)).toBe('demo');
    });

    it('inserts the same 150 lines sent raw, without paste markers, as text', () => {
      expectPasteHandledAsText(drive('paste-raw'));
    });

    // Ink hands the short first line over as its own event before the first escape sequence, and
    // the sequences themselves, which it does not resolve, as their tails with the ESC removed.
    it('inserts a raw paste of coloured text as text, every escape sequence dropped whole', () => {
      const result = drive('paste-raw-ansi');
      expectPasteHandledAsText(result);
      expect(result.query_line, JSON.stringify(result)).toBe(COLOURED_PASTE_AS_TEXT);
    });

    for (const { scenario, shown } of EMBEDDED_MARKER_PASTES) {
      it(`inserts a raw paste carrying a marker pair, a CR and a Ctrl+F as text (${scenario})`, () => {
        const result = drive(scenario);
        expectPasteHandledAsText(result);
        expect(result.query_line, JSON.stringify(result)).toBe(shown);
        expect(favoritesStored(), JSON.stringify(result)).toBe(0);
      });
    }

    for (const seed of RANDOM_SEEDS) {
      it(`survives 4096 random bytes (seed ${seed}) and quits within 2 s of Ctrl+C`, () => {
        const result = drive('random', ['--seed', String(seed)]);
        const info = JSON.stringify(result);
        expect(result.error, info).toBeUndefined();
        expect(result.exit_status, info).toBe(0);
        expect(result.ctrl_c_to_exit_ms, info).toBeLessThan(FAST_MS);
        expect(result.output_tail, info).not.toMatch(CRASH_OUTPUT);
      });
    }

    it('positive control: Enter on a typed query copies once and records one use', () => {
      const result = drive('enter');
      const info = JSON.stringify(result);
      expect(result.error, info).toBeUndefined();
      expect(result.exit_status, info).toBe(0);
      expect(result.clip_invocations, info).toBe(1);
      expect(recordedUsage(), info).toBe(1);
    });

    describe.skipIf(!RUN_SLOW)('with vault.db locked for 30 s (COMMANDVAULT_E2E_SLOW=1)', () => {
      it('names the failed favorite within 25 s, stays alive and quits after the release', () => {
        const result = drive(
          'lock',
          ['--db', join(box.dataDir, 'vault.db'), '--hold-seconds', String(LOCK_HOLD_S)],
          LOCK_DEADLINE_S,
        );
        const info = JSON.stringify(result);
        expect(result.error, info).toBeUndefined();
        expect(result.message_ms, info).not.toBeNull();
        expect(result.message_ms ?? Infinity, info).toBeLessThan(LOCK_MESSAGE_WITHIN_MS);
        expect(result.exited_before_ctrl_c, info).toBe(false);
        expect(result.ctrl_c_to_exit_ms, info).toBeLessThan(FAST_MS);
        expect(result.exit_status, info).toBe(0);
        expect(result.output_tail, info).not.toMatch(CRASH_OUTPUT);
      });
    });
  },
);
