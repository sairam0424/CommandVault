import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CommanderError } from 'commander';
import {
  CommandError,
  EXIT_RUNTIME_ERROR,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_USAGE_ERROR,
  installProcessHandlers,
  onShutdown,
  restoreTerminal,
  runCli,
  usageError,
  withCommand,
  type ExitSink,
  type HandlerProcess,
} from '../errors.js';

function makeSink(debug = false) {
  const writes: string[] = [];
  const exits: number[] = [];
  const sink: ExitSink = {
    writeError: (text) => writes.push(text),
    exit: (code) => exits.push(code),
    isDebug: () => debug,
  };
  return { sink, writes, exits };
}

class FakeStream extends EventEmitter {
  isTTY = false;
  readonly writes: string[] = [];
  write(text: string): boolean {
    this.writes.push(text);
    return true;
  }
}

function makeProc() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new FakeStream(),
    stderr: new FakeStream(),
  });
  return { proc, handlerProc: proc as unknown as HandlerProcess, stdin };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('withCommand', () => {
  it('lets a successful run finish without touching the exit code or stderr', async () => {
    const { sink, writes, exits } = makeSink();
    const run = vi.fn().mockResolvedValue(undefined);
    await withCommand(run, sink);
    expect(run).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    expect(exits).toEqual([]);
  });

  it('reports a CommandError as one error: line and exits with its code', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(() => Promise.reject(usageError('bad input')), sink);
    expect(writes).toEqual(['error: bad input\n']);
    expect(exits).toEqual([EXIT_USAGE_ERROR]);
  });

  it('prints the hint on its own line', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(
      () => Promise.reject(new CommandError('backup failed', EXIT_RUNTIME_ERROR, 'run vault list')),
      sink,
    );
    expect(writes).toEqual(['error: backup failed\nhint: run vault list\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });

  it('exits 1 for any other Error, without a stack trace', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(() => Promise.reject(new TypeError('boom')), sink);
    expect(writes).toEqual(['error: boom\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });

  it('exits 1 for a thrown non-Error', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(() => Promise.reject('plain string'), sink);
    expect(writes).toEqual(['error: plain string\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });

  it('adds the stack trace only when debugging is on', async () => {
    const { sink, writes } = makeSink(true);
    await withCommand(() => Promise.reject(new CommandError('nope')), sink);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^error: nope\n/);
    expect(writes[0]).toMatch(/\n\s+at /);
  });

  it('exits 0 silently after commander displayed help or the version', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(
      () => Promise.reject(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)')),
      sink,
    );
    await withCommand(
      () => Promise.reject(new CommanderError(0, 'commander.version', '1.2.3')),
      sink,
    );
    expect(writes).toEqual([]);
    expect(exits).toEqual([0, 0]);
  });

  it('exits 0 silently for commanders implicit help subcommand', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(
      () => Promise.reject(new CommanderError(0, 'commander.help', '(outputHelp)')),
      sink,
    );
    expect(writes).toEqual([]);
    expect(exits).toEqual([0]);
  });

  it('keeps a commander error with a non-zero exit code a usage error', async () => {
    const { sink, exits } = makeSink();
    await withCommand(
      () => Promise.reject(new CommanderError(1, 'commander.help', '(outputHelp)')),
      sink,
    );
    expect(exits).toEqual([EXIT_USAGE_ERROR]);
  });

  it('maps every other commander error to a usage exit without repeating its message', async () => {
    const { sink, writes, exits } = makeSink();
    await withCommand(
      () =>
        Promise.reject(new CommanderError(1, 'commander.unknownCommand', "unknown command 'x'")),
      sink,
    );
    expect(writes).toEqual([]);
    expect(exits).toEqual([EXIT_USAGE_ERROR]);
  });

  it('exits 130 silently when the user cancels an inquirer prompt', async () => {
    const { sink, writes, exits } = makeSink();
    const cancelled = Object.assign(new Error('User force closed the prompt'), {
      name: 'ExitPromptError',
    });
    await withCommand(() => Promise.reject(cancelled), sink);
    expect(writes).toEqual([]);
    expect(exits).toEqual([EXIT_SIGINT]);
  });
});

describe('installProcessHandlers', () => {
  it('turns an unhandled rejection into an error: line and exit 1', () => {
    const { sink, writes, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    proc.emit('unhandledRejection', new Error('async boom'));
    expect(writes).toEqual(['error: async boom\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });

  it('turns an uncaught exception into an error: line and exit 1', () => {
    const { sink, writes, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    proc.emit('uncaughtException', new Error('sync boom'));
    expect(writes).toEqual(['error: sync boom\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });

  it('exits 0 quietly when stdout is closed (EPIPE)', () => {
    const { sink, writes, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    proc.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(writes).toEqual([]);
    expect(exits).toEqual([0]);
  });

  it('reports any other stdout write error and exits 1', () => {
    const { sink, writes, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    proc.stdout.emit('error', Object.assign(new Error('no space left'), { code: 'ENOSPC' }));
    expect(writes).toEqual(['error: no space left\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });

  it.each([
    ['SIGINT', EXIT_SIGINT],
    ['SIGTERM', EXIT_SIGTERM],
  ])('%s runs the shutdown hooks and then exits %i', async (signal, code) => {
    const { sink, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    const order: string[] = [];
    installProcessHandlers(handlerProc, sink);
    const unregister = onShutdown(() => {
      order.push('hook');
    });
    try {
      proc.emit(signal);
      await vi.waitFor(() => expect(exits).toEqual([code]));
      expect(order).toEqual(['hook']);
    } finally {
      unregister();
    }
  });

  it.each([
    ['SIGINT', EXIT_SIGINT],
    ['SIGTERM', EXIT_SIGTERM],
  ])('%s puts a raw-mode terminal back before exiting %i', async (signal, code) => {
    const exits: number[] = [];
    const { proc, handlerProc, stdin } = makeProc();
    stdin.isTTY = true;
    stdin.isRaw = true;
    proc.stdout.isTTY = true;
    // Record what the terminal looked like at the moment the process was told to exit.
    const atExit: { rawModeOff: boolean; cursorShown: boolean }[] = [];
    const sink: ExitSink = {
      writeError: () => {},
      isDebug: () => false,
      exit: (exitCode) => {
        exits.push(exitCode);
        atExit.push({
          rawModeOff: stdin.setRawMode.mock.calls.some(([mode]) => mode === false),
          cursorShown: proc.stdout.writes.includes('\u001B[?25h'),
        });
      },
    };
    installProcessHandlers(handlerProc, sink);

    proc.emit(signal);

    await vi.waitFor(() => expect(exits).toEqual([code]));
    expect(atExit).toEqual([{ rawModeOff: true, cursorShown: true }]);
  });

  it('still exits when a shutdown hook fails or never finishes', async () => {
    vi.useFakeTimers();
    const { sink, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    const unregisterFailing = onShutdown(() => Promise.reject(new Error('cleanup failed')));
    const unregisterHanging = onShutdown(() => new Promise<void>(() => {}));
    try {
      proc.emit('SIGINT');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exits).toEqual([EXIT_SIGINT]);
    } finally {
      unregisterFailing();
      unregisterHanging();
    }
  });

  it('a second signal while shutting down exits immediately', async () => {
    const { sink, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    const unregister = onShutdown(() => new Promise<void>(() => {}));
    try {
      proc.emit('SIGINT');
      proc.emit('SIGINT');
      expect(exits).toEqual([EXIT_SIGINT]);
    } finally {
      unregister();
    }
  });

  it('does not run an unregistered shutdown hook', async () => {
    const { sink, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    installProcessHandlers(handlerProc, sink);
    const hook = vi.fn();
    onShutdown(hook)();
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exits).toEqual([EXIT_SIGTERM]));
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('restoreTerminal', () => {
  it('leaves raw mode and shows the cursor on a TTY', () => {
    const { proc, handlerProc, stdin } = makeProc();
    stdin.isTTY = true;
    stdin.isRaw = true;
    proc.stdout.isTTY = true;
    restoreTerminal(handlerProc);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(proc.stdout.writes).toEqual(['\u001B[?25h']);
    expect(proc.stderr.writes).toEqual([]);
  });

  it('writes nothing and leaves stdin alone when nothing is a TTY', () => {
    const { proc, handlerProc, stdin } = makeProc();
    restoreTerminal(handlerProc);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(proc.stdout.writes).toEqual([]);
    expect(proc.stderr.writes).toEqual([]);
  });

  it('shows the cursor on stderr when only stderr is a terminal', () => {
    const { proc, handlerProc } = makeProc();
    proc.stderr.isTTY = true;
    restoreTerminal(handlerProc);
    expect(proc.stdout.writes).toEqual([]);
    expect(proc.stderr.writes).toEqual(['\u001B[?25h']);
  });
});

describe('runCli', () => {
  it('runs the command through withCommand and reports its failure', async () => {
    const { sink, writes, exits } = makeSink();
    const { handlerProc } = makeProc();
    runCli(() => Promise.reject(usageError('bad input')), handlerProc, sink);
    await vi.waitFor(() => expect(exits).toEqual([EXIT_USAGE_ERROR]));
    expect(writes).toEqual(['error: bad input\n']);
  });

  it('stays quiet when the command finishes before the event loop drains', async () => {
    const { sink, writes, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    runCli(() => Promise.resolve(), handlerProc, sink);
    await new Promise((resolve) => setImmediate(resolve));
    proc.emit('beforeExit');
    expect(writes).toEqual([]);
    expect(exits).toEqual([]);
  });

  it('fails with an error: line when the loop drains while the command is still pending', () => {
    const { sink, writes, exits } = makeSink();
    const { proc, handlerProc } = makeProc();
    runCli(() => new Promise<void>(() => {}), handlerProc, sink);
    proc.emit('beforeExit');
    expect(writes).toEqual(['error: input ended before the command finished\n']);
    expect(exits).toEqual([EXIT_RUNTIME_ERROR]);
  });
});
