import { rmSync } from 'node:fs';
import { runRootFor } from './run-root.js';
import {
  diffRealHome,
  formatSentinelFailure,
  snapshotRealHome,
  watchedPaths,
} from './real-home-sentinel.js';

/** The part of vitest's `TestProject` used here: a value given to `provide` reaches tests via `inject`. */
interface SetupProject {
  provide(key: 'realHomeSentinel', value: readonly string[]): void;
}

/** Deletes the temp HOMEs of this run; returns a description of the failure instead of throwing. */
function removeRunRoot(): string | undefined {
  const root = runRootFor(process.pid);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      `Could not remove the temp HOMEs of this run at ${root}: ${reason}`,
      'A test probably left a read-only directory in its HOME: fix it, then delete the directory.',
    ].join('\n');
  }
}

/**
 * Runs once in the vitest MAIN process, before any worker exists and before any override of HOME,
 * so this is where the real locations are looked at. The returned teardown looks again and fails
 * the whole run when anything changed, then removes the temp HOMEs the workers created. The look
 * comes first and both problems are reported together: a temp HOME that cannot be removed must
 * not hide a write to the real one.
 */
export default function setup(project: SetupProject): () => void {
  const before = snapshotRealHome();
  // Lets a test in every package prove the guard is wired into that package's vitest config.
  project.provide('realHomeSentinel', watchedPaths(before));

  return function teardown(): void {
    const changes = diffRealHome(before, snapshotRealHome());
    const cleanupFailure = removeRunRoot();

    const problems = [
      ...(changes.length > 0 ? [formatSentinelFailure(changes)] : []),
      ...(cleanupFailure ? [cleanupFailure] : []),
    ];
    if (problems.length > 0) throw new Error(problems.join('\n\n'));
  };
}
