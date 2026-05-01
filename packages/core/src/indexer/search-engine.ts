import type { VaultEntry, SearchResult, SearchOptions, SearchTier, VaultStats } from '../types/index.js';
import { FuseEngine } from './fuse-engine.js';
import { MiniSearchEngine } from './minisearch-engine.js';
import { SqliteEngine } from './sqlite-engine.js';

export class SearchEngine {
  private readonly fuseEngine: FuseEngine;
  private readonly miniSearchEngine: MiniSearchEngine;
  private readonly sqliteEngine: SqliteEngine;
  private readonly defaultTier: SearchTier;

  constructor(dbPath: string, defaultTier: SearchTier = 'minisearch') {
    this.fuseEngine = new FuseEngine();
    this.miniSearchEngine = new MiniSearchEngine();
    this.sqliteEngine = new SqliteEngine(dbPath);
    this.defaultTier = defaultTier;
  }

  index(entries: readonly VaultEntry[]): void {
    this.fuseEngine.index(entries);
    this.miniSearchEngine.index(entries);
    this.sqliteEngine.index(entries);
  }

  search(options: SearchOptions): SearchResult[] {
    const tier = options.tier ?? this.defaultTier;

    switch (tier) {
      case 'fuse':
        return this.fuseEngine.search(options);
      case 'minisearch':
        return this.miniSearchEngine.search(options);
      case 'sqlite':
        return this.sqliteEngine.search(options);
    }
  }

  suggest(query: string, limit?: number): string[] {
    return this.miniSearchEngine.suggest(query, limit);
  }

  toggleFavorite(id: string): boolean {
    return this.sqliteEngine.toggleFavorite(id);
  }

  incrementUsage(id: string): void {
    this.sqliteEngine.incrementUsage(id);
  }

  getStats(): VaultStats {
    return this.sqliteEngine.getStats();
  }

  getEntry(id: string): VaultEntry | undefined {
    return this.sqliteEngine.getEntry(id);
  }

  close(): void {
    this.sqliteEngine.close();
  }
}
