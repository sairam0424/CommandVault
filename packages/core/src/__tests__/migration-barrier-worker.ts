/**
 * One process of migration-barrier.test.ts. It is compiled with the package, and the test runs the
 * compiled file, because the processes must load the modules a user's would.
 *
 * usage: node migration-barrier-worker.js <workerId> <warmupPath>
 * It loads the engine and opens a scratch database once, so that nothing is left to load when a
 * round starts, then tells its parent it is ready. For each round the parent sends it
 * `{ dbPath, startAt }`: it waits for the clock to reach `startAt`, opens that database once, and
 * reports what went wrong, if anything.
 */

// A module, not a script: the other workers in this folder are scripts with the same names.
export {};

interface Round {
  readonly dbPath: string;
  readonly startAt: number;
}

interface Failure {
  readonly name: string;
  readonly message: string;
}

const [workerId, warmupPath] = process.argv.slice(2);

function describeFailure(error: unknown): Failure {
  const failure = error instanceof Error ? error : new Error(String(error));
  return { name: failure.name, message: failure.message };
}

async function main(): Promise<void> {
  const { SqliteEngine } = await import('../indexer/sqlite-engine.js');
  (await SqliteEngine.create(warmupPath!)).close();

  process.on('message', (message) => {
    const { dbPath, startAt } = message as Round;
    // A spin, not a timer: every worker leaves the barrier within about a millisecond of the rest.
    while (Date.now() < startAt) {
      /* wait */
    }
    SqliteEngine.create(dbPath).then(
      (engine) => {
        engine.close();
        process.send?.({ workerId });
      },
      (error: unknown) => process.send?.({ workerId, failure: describeFailure(error) }),
    );
  });
  process.send?.('ready');
}

main().catch((error: unknown) => {
  process.send?.({ workerId, failure: describeFailure(error) });
});
