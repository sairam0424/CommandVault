import type { SqliteConnection } from './sqlite-connection.js';

export class TagStore {
  private readonly conn: SqliteConnection;

  constructor(conn: SqliteConnection) {
    this.conn = conn;
  }

  addTag(entryId: string, tag: string): void {
    this.conn.execute('INSERT OR IGNORE INTO user_tags (entry_id, tag) VALUES ($entryId, $tag)', {
      $entryId: entryId,
      $tag: tag,
    });
    this.conn.persist();
  }

  removeTag(entryId: string, tag: string): void {
    this.conn.execute('DELETE FROM user_tags WHERE entry_id = $entryId AND tag = $tag', {
      $entryId: entryId,
      $tag: tag,
    });
    this.conn.persist();
  }

  getTagsForEntry(entryId: string): string[] {
    const rows = this.conn.queryAll<{ tag: string }>(
      'SELECT tag FROM user_tags WHERE entry_id = $entryId',
      { $entryId: entryId },
    );
    return rows.map((r) => r.tag);
  }

  getUserTags(): string[] {
    const rows = this.conn.queryAll<{ tag: string }>(
      'SELECT DISTINCT tag FROM user_tags ORDER BY tag',
    );
    return rows.map((r) => r.tag);
  }
}
