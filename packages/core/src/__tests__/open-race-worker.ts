/**
 * One process of db-open-concurrent-repair.test.ts. It is compiled with the package, and the test
 * runs the compiled file, because the processes must load the same modules a user's would.
 *
 * usage: node open-race-worker.js <dbPath> <workerId> <rowCount>
 * It loads everything, says "ready", and waits until its standard input is closed; then it opens the
 * database, creates a table, inserts `rowCount` rows and reports what it did as one JSON line.
 */
import { once } from 'node:events';

const [dbPath, workerId, rowCountText] = process.argv.slice(2);

async function main(): Promise<void> {
  // Load what an open needs now, so that the opens of all the processes start together.
  await import('better-sqlite3');
  await import('../indexer/better-sqlite-adapter.js');
  const { createDatabaseAdapter } = await import('../indexer/database-factory.js');
  process.stdout.write('ready\n');
  process.stdin.resume();
  await once(process.stdin, 'end');

  const adapter = await createDatabaseAdapter(dbPath!);
  adapter.execute('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)');
  for (let row = 0; row < Number(rowCountText); row += 1) {
    adapter.execute('INSERT INTO t (id) VALUES ($id)', { $id: `${workerId}.${row}` });
  }
  const rowsSeen = adapter.queryAll<{ id: string }>('SELECT id FROM t').length;
  adapter.close();
  report({ ok: true, workerId, rowsSeen });
}

function report(outcome: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main().catch((error: unknown) => {
  const failure = error instanceof Error ? error : new Error(String(error));
  report({ ok: false, workerId, name: failure.name, message: failure.message });
});
