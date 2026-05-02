import type { VaultEntry, SearchResult, SearchOptions, VaultStats } from '../types/index.js';
import { SqliteConnection } from './sqlite-connection.js';
import { EntryStore } from './entry-store.js';
import { TagStore } from './tag-store.js';
import { SnapshotStore } from './snapshot-store.js';
import { StatsStore } from './stats-store.js';

export class SqliteEngine {
  private readonly conn: SqliteConnection;
  private readonly entryStore: EntryStore;
  private readonly tagStore: TagStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly statsStore: StatsStore;

  private constructor(conn: SqliteConnection) {
    this.conn = conn;
    this.entryStore = new EntryStore(conn);
    this.tagStore = new TagStore(conn);
    this.snapshotStore = new SnapshotStore(conn);
    this.statsStore = new StatsStore(conn);
  }

  static async create(dbPath: string): Promise<SqliteEngine> {
    const conn = await SqliteConnection.create(dbPath);
    return new SqliteEngine(conn);
  }

  index(entries: readonly VaultEntry[]): void {
    this.entryStore.index(entries);
  }

  search(options: SearchOptions): SearchResult[] {
    return this.entryStore.search(options);
  }

  toggleFavorite(id: string): boolean {
    return this.entryStore.toggleFavorite(id);
  }

  incrementUsage(id: string): void {
    this.entryStore.incrementUsage(id);
  }

  getEntry(id: string): VaultEntry | undefined {
    return this.entryStore.getEntry(id);
  }

  getStats(): VaultStats {
    return this.statsStore.getStats();
  }

  addTag(entryId: string, tag: string): void {
    this.tagStore.addTag(entryId, tag);
  }

  removeTag(entryId: string, tag: string): void {
    this.tagStore.removeTag(entryId, tag);
  }

  getTagsForEntry(entryId: string): string[] {
    return this.tagStore.getTagsForEntry(entryId);
  }

  saveSnapshot(entries: readonly VaultEntry[]): void {
    this.snapshotStore.saveSnapshot(entries);
  }

  getDiff(currentEntries: readonly VaultEntry[]): {
    added: VaultEntry[];
    removed: string[];
    modified: VaultEntry[];
  } {
    return this.snapshotStore.getDiff(currentEntries);
  }

  close(): void {
    this.conn.close();
  }
}
