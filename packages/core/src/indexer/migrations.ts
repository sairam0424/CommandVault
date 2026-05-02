import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: Database.Database) => void;
}

function stableId(type: string, name: string, source: string): string {
  return createHash('sha256').update(`${type}:${name}:${source}`).digest('hex').slice(0, 12);
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Add entry_tags junction table for exact tag matching',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entry_tags (
          entry_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (entry_id, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);
      `);
    },
  },
  {
    version: 2,
    description: 'Migrate entry IDs from filePath-based to type+name-based',
    up: (db) => {
      const rows = db.prepare('SELECT id, name, type, source FROM entries').all() as Array<{
        id: string; name: string; type: string; source: string;
      }>;

      const updateEntry = db.prepare('UPDATE entries SET id = ? WHERE id = ?');
      const updateUserTag = db.prepare('UPDATE user_tags SET entry_id = ? WHERE entry_id = ?');
      const updateEntryTag = db.prepare('UPDATE entry_tags SET entry_id = ? WHERE entry_id = ?');
      const updateSnapshot = db.prepare('UPDATE scan_snapshots SET id = ? WHERE id = ?');
      const deleteEntry = db.prepare('DELETE FROM entries WHERE id = ?');
      const deleteUserTags = db.prepare('DELETE FROM user_tags WHERE entry_id = ?');
      const deleteEntryTags = db.prepare('DELETE FROM entry_tags WHERE entry_id = ?');
      const deleteSnapshot = db.prepare('DELETE FROM scan_snapshots WHERE id = ?');

      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const newId = stableId(row.type, row.name, row.source);
        const existing = groups.get(newId) ?? [];
        existing.push(row.id);
        groups.set(newId, existing);
      }

      for (const [newId, oldIds] of groups) {
        for (let i = 1; i < oldIds.length; i++) {
          deleteEntryTags.run(oldIds[i]);
          deleteUserTags.run(oldIds[i]);
          deleteSnapshot.run(oldIds[i]);
          deleteEntry.run(oldIds[i]);
        }
        if (newId !== oldIds[0]) {
          updateEntry.run(newId, oldIds[0]);
          updateUserTag.run(newId, oldIds[0]);
          updateEntryTag.run(newId, oldIds[0]);
          updateSnapshot.run(newId, oldIds[0]);
        }
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL
    );
  `);

  const currentVersion = (
    db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number | null;
    }
  ).v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  const insertVersion = db.prepare(
    'INSERT INTO schema_version (version, description) VALUES (?, ?)',
  );

  const transaction = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      insertVersion.run(migration.version, migration.description);
    }
  });

  transaction();
}
