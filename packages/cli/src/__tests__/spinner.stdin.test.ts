import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpinner } from '../ui/spinner.js';

/**
 * Runs the REAL ora against a TTY-shaped stdin/stderr. stdin-discarder only acts when
 * process.stdin.isTTY is true; it then pauses stdin on stop(), which is what made the TUI deaf.
 */

type Patchable = Record<string, unknown>;

function patch(target: object, key: string, value: unknown): () => void {
  const holder = target as Patchable;
  const hadOwn = Object.prototype.hasOwnProperty.call(holder, key);
  const previous = holder[key];
  Object.defineProperty(holder, key, { value, configurable: true, writable: true });
  return () => {
    if (hadOwn)
      Object.defineProperty(holder, key, { value: previous, configurable: true, writable: true });
    else delete holder[key];
  };
}

describe('createSpinner with a TTY stdin', () => {
  const restores: Array<() => void> = [];
  let pause: ReturnType<typeof vi.spyOn>;
  let setRawMode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setRawMode = vi.fn();
    restores.push(patch(process.stdin, 'isTTY', true));
    restores.push(patch(process.stdin, 'setRawMode', setRawMode));
    restores.push(patch(process.stderr, 'isTTY', true));
    restores.push(patch(process.stderr, 'columns', 80));
    for (const method of ['cursorTo', 'clearLine', 'moveCursor']) {
      restores.push(patch(process.stderr, method, vi.fn()));
    }
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    pause = vi.spyOn(process.stdin, 'pause');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    while (restores.length > 0) restores.pop()?.();
  });

  it('leaves stdin flowing after start and stop', () => {
    process.stdin.resume();
    expect(process.stdin.isPaused()).toBe(false);

    const spinner = createSpinner('Initializing vault...').start();
    spinner.stop();

    expect(pause).not.toHaveBeenCalled();
    expect(setRawMode).not.toHaveBeenCalled();
    expect(process.stdin.isPaused()).toBe(false);
  });

  it('leaves stdin flowing after succeed and fail', () => {
    process.stdin.resume();

    createSpinner('one').start().succeed('done');
    createSpinner('two').start().fail('failed');

    expect(pause).not.toHaveBeenCalled();
    expect(process.stdin.isPaused()).toBe(false);
  });
});
