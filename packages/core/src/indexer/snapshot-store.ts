import { createHash } from 'node:crypto';
import type { VaultEntry } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';

export class SnapshotStore {
  private readonly conn: DatabaseAdapter;

  constructor(conn: DatabaseAdapter) {
    this.conn = conn;
  }

  saveSnapshot(entries: readonly VaultEntry[]): void {
    this.conn.transaction(() => {
      this.conn.execute('DELETE FROM scan_snapshots');
      for (const entry of entries) {
        const hash = createHash('sha256')
          .update(entry.name + entry.type + entry.content)
          .digest('hex');
        this.conn.execute(
          'INSERT INTO scan_snapshots (id, name, type, content_hash) VALUES ($id, $name, $type, $hash)',
          { $id: entry.id, $name: entry.name, $type: entry.type, $hash: hash },
        );
      }
    });
  }

  getDiff(currentEntries: readonly VaultEntry[]): {
    added: VaultEntry[];
    removed: string[];
    modified: VaultEntry[];
  } {
    const snapshotRows = this.conn.queryAll<{
      id: string;
      name: string;
      type: string;
      content_hash: string;
    }>('SELECT * FROM scan_snapshots');

    const snapshotMap = new Map(snapshotRows.map((r) => [r.id, r]));
    const currentMap = new Map(currentEntries.map((e) => [e.id, e]));

    const added: VaultEntry[] = [];
    const removed: string[] = [];
    const modified: VaultEntry[] = [];

    for (const entry of currentEntries) {
      const snapshot = snapshotMap.get(entry.id);
      if (!snapshot) {
        added.push(entry);
      } else {
        const currentHash = createHash('sha256')
          .update(entry.name + entry.type + entry.content)
          .digest('hex');
        if (currentHash !== snapshot.content_hash) {
          modified.push(entry);
        }
      }
    }

    for (const [id, row] of snapshotMap) {
      if (!currentMap.has(id)) {
        removed.push(row.name);
      }
    }

    return { added, removed, modified };
  }

  getSnapshots(): Array<{ id: string; name: string; type: string; contentHash: string }> {
    const rows = this.conn.queryAll<{
      id: string;
      name: string;
      type: string;
      content_hash: string;
    }>('SELECT * FROM scan_snapshots');
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      contentHash: r.content_hash,
    }));
  }
}
