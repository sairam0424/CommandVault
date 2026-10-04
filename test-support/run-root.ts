import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The directory that holds every temp HOME of one vitest run. It is named after the vitest MAIN
 * process so a worker (whose parent is that process) and the global teardown agree on it without
 * passing anything between them, and the teardown can delete all of it in one go.
 */
export function runRootFor(mainPid: number): string {
  return join(tmpdir(), `commandvault-test-${mainPid}`);
}
