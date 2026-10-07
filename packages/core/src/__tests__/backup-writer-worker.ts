/**
 * One process of the backup and restore tests: a writer that commits `count` usage increments of
 * one entry into the write-ahead log of a migrated vault.db and then keeps its connection open,
 * with automatic checkpoints switched off, so the commits stay in the -wal and never reach the
 * main file. The VS Code extension and `vault watch` hold a connection open the same way.
 * It is compiled with the package and run from dist, like the other workers in this folder.
 *
 * usage: node backup-writer-worker.js <dbPath> <entryId> <count>
 * Reports `{ usage }` over IPC once the commits are acknowledged; closes cleanly on the 'stop'
 * message. Killed instead, it leaves a hot -wal behind, the way a crashed process does.
 */

// A module, not a script: the other workers in this folder are scripts with the same names.
export {};

import Database from 'better-sqlite3';

const [dbPath, entryId, count] = process.argv.slice(2);

const db = new Database(dbPath!);
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 0');
db.pragma('busy_timeout = 10000');
const bump = db.prepare('UPDATE entries SET usage_count = usage_count + 1 WHERE id = ?');
for (let commit = 0; commit < Number(count); commit += 1) bump.run(entryId);
const row = db.prepare('SELECT usage_count AS usage FROM entries WHERE id = ?').get(entryId) as {
  usage: number;
};

process.on('message', (message) => {
  if (message !== 'stop') return;
  db.close();
  process.exit(0);
});
process.send?.({ usage: row.usage });
