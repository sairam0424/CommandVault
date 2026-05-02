import { createHash } from 'node:crypto';
import type { Database as SqlJsDatabase } from 'sql.js';

interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: SqlJsDatabase) => void;
}

function stableId(type: string, name: string, source: string): string {
  return createHash('sha256').update(`${type}:${name}:${source}`).digest('hex').slice(0, 12);
}

/** Helper: run a SELECT and return rows as plain objects. */
function queryAll<T extends Record<string, unknown>>(
  db: SqlJsDatabase,
  sql: string,
  params: Record<string, unknown> = {},
): T[] {
  const stmt = db.prepare(sql);
  if (Object.keys(params).length > 0) {
    stmt.bind(params);
  }
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Add entry_tags junction table for exact tag matching',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS entry_tags (
          entry_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (entry_id, tag)
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);`);
    },
  },
  {
    version: 2,
    description: 'Migrate entry IDs from filePath-based to type+name-based',
    up: (db) => {
      const rows = queryAll<{
        id: string; name: string; type: string; source: string;
      }>(db, 'SELECT id, name, type, source FROM entries');

      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const newId = stableId(row.type, row.name, row.source);
        const existing = groups.get(newId) ?? [];
        existing.push(row.id);
        groups.set(newId, existing);
      }

      for (const [newId, oldIds] of groups) {
        for (let i = 1; i < oldIds.length; i++) {
          db.run('DELETE FROM entry_tags WHERE entry_id = $id', { $id: oldIds[i] });
          db.run('DELETE FROM user_tags WHERE entry_id = $id', { $id: oldIds[i] });
          db.run('DELETE FROM scan_snapshots WHERE id = $id', { $id: oldIds[i] });
          db.run('DELETE FROM entries WHERE id = $id', { $id: oldIds[i] });
        }
        if (newId !== oldIds[0]) {
          db.run('UPDATE entries SET id = $new WHERE id = $old', { $new: newId, $old: oldIds[0] });
          db.run('UPDATE user_tags SET entry_id = $new WHERE entry_id = $old', { $new: newId, $old: oldIds[0] });
          db.run('UPDATE entry_tags SET entry_id = $new WHERE entry_id = $old', { $new: newId, $old: oldIds[0] });
          db.run('UPDATE scan_snapshots SET id = $new WHERE id = $old', { $new: newId, $old: oldIds[0] });
        }
      }
    },
  },
];

export function runMigrations(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL
    );
  `);

  const versionRows = queryAll<{ v: number | null }>(
    db,
    'SELECT MAX(version) as v FROM schema_version',
  );
  const currentVersion = versionRows[0]?.v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  db.run('BEGIN');
  try {
    for (const migration of pending) {
      migration.up(db);
      db.run(
        'INSERT INTO schema_version (version, description) VALUES ($version, $description)',
        { $version: migration.version, $description: migration.description },
      );
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}
