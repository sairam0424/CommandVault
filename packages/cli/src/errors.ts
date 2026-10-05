import { CommanderError } from 'commander';

export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

/** Name of the error @inquirer/prompts rejects with when the user presses Ctrl+C in a prompt. */
const PROMPT_CANCELLED_ERROR = 'ExitPromptError';

const INPUT_ENDED_MESSAGE = 'input ended before the command finished';

const SHOW_CURSOR = '\u001B[?25h';
const FLUSH_TIMEOUT_MS = 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * A failure the user can act on. Carries the exit code (usage/validation errors use
 * {@link EXIT_USAGE_ERROR}) and an optional one-line hint; never printed with a stack trace.
 */
export class CommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_RUNTIME_ERROR,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export function usageError(message: string, hint?: string): CommandError {
  return new CommandError(message, EXIT_USAGE_ERROR, hint);
}

function joinWithOr(values: readonly string[]): string {
  return values.length < 2
    ? values.join('')
    : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

/** Usage error for a value outside a fixed set; `origin` names the file it came from, if any. */
export function invalidChoiceError(
  subject: string,
  value: unknown,
  choices: readonly string[],
  origin?: string,
): CommandError {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  const where = origin ? ` in ${origin}` : '';
  return usageError(`invalid ${subject} "${shown}"${where} (expected ${joinWithOr(choices)})`);
}

/** Where failures go. Injectable so the behaviour can be unit tested without exiting. */
export interface ExitSink {
  writeError(text: string): void;
  exit(code: number): void;
  isDebug(): boolean;
}

interface WritableLike {
  readonly isTTY?: boolean;
  readonly destroyed?: boolean;
  write(text: string, callback?: () => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

interface ReadableLike {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** The slice of `process` that the handlers in this module touch. */
export interface HandlerProcess {
  readonly stdin: ReadableLike;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** Ends the process once stdout and stderr have drained, so a short error is never cut off. */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const pending = [process.stderr, process.stdout].filter((stream) => !stream.destroyed);
  const timer = setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS);
  timer.unref();
  const flushNext = (): void => {
    const stream = pending.shift();
    if (stream === undefined) {
      process.exit(code);
    }
    stream.write('', flushNext);
  };
  flushNext();
}

export const processSink: ExitSink = {
  writeError: (text) => {
    process.stderr.write(text);
  },
  exit: exitAfterFlush,
  isDebug: () => process.env['VAULT_DEBUG'] === '1',
};

interface Failure {
  readonly code: number;
  readonly lines: readonly string[];
}

function describeFailure(error: unknown, debug: boolean): Failure {
  if (error instanceof CommanderError) {
    // Commander has already printed its own message for a parse error.
    // Commander's own exit code is 0 for --help, --version and the implicit `help` subcommand.
    const code = error.exitCode === 0 ? EXIT_SUCCESS : EXIT_USAGE_ERROR;
    return { code, lines: [] };
  }
  if (error instanceof Error && error.name === PROMPT_CANCELLED_ERROR) {
    return { code: EXIT_SIGINT, lines: [] };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CommandError ? error.exitCode : EXIT_RUNTIME_ERROR;
  const hint = error instanceof CommandError && error.hint ? [`hint: ${error.hint}`] : [];
  const stack = debug && error instanceof Error && error.stack ? [error.stack] : [];
  return { code, lines: [`error: ${message}`, ...hint, ...stack] };
}

function report(failure: Failure, sink: ExitSink): void {
  if (failure.lines.length > 0) {
    sink.writeError(`${failure.lines.join('\n')}\n`);
  }
  sink.exit(failure.code);
}

/**
 * The single choke point for a CLI invocation: runs `run` and turns any failure into one
 * `error: <message>` line on stderr plus the matching exit code (2 usage, 1 runtime, 0 for
 * --help/--version). Nothing else in the CLI should call `process.exit` for a user-facing error.
 */
export async function withCommand(
  run: () => Promise<unknown>,
  sink: ExitSink = processSink,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    report(describeFailure(error, sink.isDebug()), sink);
  }
}

/**
 * Runs the whole CLI invocation through {@link withCommand}. Deliberately not awaited by the
 * caller: a top-level `await` on a promise that can never settle (a prompt whose stdin reached EOF)
 * makes Node print its "unsettled top-level await" warning and pick its own exit code. Instead,
 * when the event loop drains with the command still pending, say so and exit 1.
 */
export function runCli(
  run: () => Promise<unknown>,
  proc: HandlerProcess = process,
  sink: ExitSink = processSink,
): void {
  let settled = false;
  proc.on('beforeExit', () => {
    if (!settled) {
      settled = true;
      report({ code: EXIT_RUNTIME_ERROR, lines: [`error: ${INPUT_ENDED_MESSAGE}`] }, sink);
    }
  });
  void withCommand(run, sink).finally(() => {
    settled = true;
  });
}

type ShutdownHook = () => Promise<void> | void;

const shutdownHooks = new Set<ShutdownHook>();

/** Registers cleanup to run when SIGINT/SIGTERM arrives. Returns a function that unregisters it. */
export function onShutdown(hook: ShutdownHook): () => void {
  const registered: ShutdownHook = () => hook();
  shutdownHooks.add(registered);
  return () => {
    shutdownHooks.delete(registered);
  };
}

async function runShutdownHooks(): Promise<void> {
  const hooks = [...shutdownHooks].map(async (hook) => {
    try {
      await hook();
    } catch {
      // Cleanup is best effort: the process is going away whether or not a hook succeeds.
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all(hooks), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Puts the terminal back the way a TUI or prompt found it: cooked mode, cursor visible. */
export function restoreTerminal(proc: HandlerProcess): void {
  if (proc.stdin.isTTY && proc.stdin.isRaw) {
    proc.stdin.setRawMode?.(false);
  }
  const terminal = [proc.stdout, proc.stderr].find((stream) => stream.isTTY);
  terminal?.write(SHOW_CURSOR);
}

/**
 * Installs the process-level handlers once, early: EPIPE on a stream exits 0 quietly (the reader
 * went away, e.g. `vault completions bash | head -1`), SIGINT/SIGTERM restore the terminal, run the
 * shutdown hooks and exit 130/143, and unhandled rejections or exceptions print one `error:` line
 * and exit 1 instead of a stack trace.
 */
export function installProcessHandlers(
  proc: HandlerProcess = process,
  sink: ExitSink = processSink,
): void {
  const fail = (error: unknown): void =>
    report({ ...describeFailure(error, sink.isDebug()), code: EXIT_RUNTIME_ERROR }, sink);

  const onStreamError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') {
      sink.exit(EXIT_SUCCESS);
      return;
    }
    fail(error);
  };
  proc.stdout.on('error', onStreamError);
  proc.stderr.on('error', onStreamError);

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      sink.exit(code);
      return;
    }
    shuttingDown = true;
    restoreTerminal(proc);
    await runShutdownHooks();
    sink.exit(code);
  };
  proc.on('SIGINT', () => void shutdown(EXIT_SIGINT));
  proc.on('SIGTERM', () => void shutdown(EXIT_SIGTERM));

  proc.on('unhandledRejection', fail);
  proc.on('uncaughtException', fail);
}
