/**
 * One process of migration-concurrency.test.ts. It is compiled with the package, and the test runs
 * the compiled file, because the processes must load the modules a user's would.
 *
 * usage: node migration-race-worker.js <dbPath> <workerId> <cycles> <entryId>
 * It loads the engine, tells its parent it is ready, and waits for the parent's "go"; then it opens
 * the database `cycles` times (open, search, count one use of `entryId`, close) and reports what
 * went wrong, if anything.
 */

interface Failure {
  readonly name: string;
  readonly message: string;
}

const [dbPath, workerId, cyclesText, entryId] = process.argv.slice(2);

function waitForGo(): Promise<void> {
  return new Promise((resolve) => {
    process.once('message', () => resolve());
    process.send?.('ready');
  });
}

function describeFailure(error: unknown): Failure {
  const failure = error instanceof Error ? error : new Error(String(error));
  return { name: failure.name, message: failure.message };
}

async function main(): Promise<void> {
  const { SqliteEngine } = await import('../indexer/sqlite-engine.js');
  await waitForGo();

  const failures: Failure[] = [];
  const cycles = Number(cyclesText);
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    try {
      const engine = await SqliteEngine.create(dbPath!);
      try {
        engine.search({ query: 'deployment', limit: 5 });
        engine.incrementUsage(entryId!);
      } finally {
        engine.close();
      }
    } catch (error) {
      failures.push(describeFailure(error));
    }
  }
  process.send?.({ workerId, cycles, failures });
}

main().catch((error: unknown) => {
  process.send?.({ workerId, cycles: 0, failures: [describeFailure(error)] });
});
