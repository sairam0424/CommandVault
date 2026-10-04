import ora, { type Ora } from 'ora';

export interface SpinnerOptions {
  readonly indent?: number;
}

/**
 * The only place that imports ora (enforced by __tests__/spinner-guard.test.ts).
 *
 * ora defaults to discardStdin: true, so stop() hands stdin to stdin-discarder, which pauses
 * process.stdin. Ink never resumes it, so the TUI that starts after the "Initializing vault"
 * spinner would draw but ignore every key, Ctrl+C included. Keep stdin flowing instead.
 * Returns an unstarted spinner; callers decide when (and whether, e.g. under --json) to start it.
 */
export function createSpinner(text: string, options: SpinnerOptions = {}): Ora {
  return ora({ text, ...options, discardStdin: false });
}
