import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { runRootFor } from './run-root.js';

/**
 * Vitest setup file: runs in every worker before the test file is imported. It gives the worker a
 * throwaway HOME so nothing a test (or the code under test) resolves through the home directory can
 * reach the developer's real ~/.commandvault or ~/.claude.
 *
 * Needs the `forks` pool: `os.homedir()` reads the process environment, which a worker thread does
 * not share with the thread that set it. Under the `threads` pool the overrides below would
 * change nothing, so this file refuses to run there instead of letting tests use the real HOME.
 *
 * Nothing here removes the temp HOME: vitest stops a forked worker with SIGTERM, which skips
 * `exit` handlers, so one registered here never fires. The global teardown deletes the whole run
 * root. A run that is interrupted before its teardown (Ctrl-C, a cancelled CI job) leaves its
 * `commandvault-test-<pid>` directory in the OS temp dir, which the OS prunes.
 */

if (!isMainThread) {
  throw new Error(
    'test-support/hermetic-home.ts needs the vitest forks pool: in a worker thread the temp HOME ' +
      'cannot take effect and the tests would run against the real one. Set pool: "forks".',
  );
}

const runRoot = runRootFor(process.ppid);
mkdirSync(runRoot, { recursive: true });
const home = mkdtempSync(join(runRoot, 'home-'));

process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['COMMANDVAULT_HOME'] = join(home, '.commandvault');
delete process.env['CLAUDE_CONFIG_DIR'];
