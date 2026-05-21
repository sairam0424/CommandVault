import type { VaultStats, EntryType } from '../types/index.js';
import type { DatabaseAdapter } from './database-adapter.js';

export class StatsStore {
  private readonly conn: DatabaseAdapter;

  constructor(conn: DatabaseAdapter) {
    this.conn = conn;
  }

  getStats(): VaultStats {
    const totalRow = this.conn.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM entries');
    const typeRows = this.conn.queryAll<{ type: string; c: number }>(
      'SELECT type, COUNT(*) as c FROM entries GROUP BY type',
    );
    const sourceRows = this.conn.queryAll<{ source: string; c: number }>(
      'SELECT source, COUNT(*) as c FROM entries GROUP BY source',
    );
    const favRow = this.conn.queryOne<{ c: number }>(
      'SELECT COUNT(*) as c FROM entries WHERE favorite = 1',
    );

    const byType = Object.fromEntries(typeRows.map((r) => [r.type, r.c])) as Record<
      EntryType,
      number
    >;
    const bySource = Object.fromEntries(sourceRows.map((r) => [r.source, r.c]));

    return {
      totalEntries: totalRow?.c ?? 0,
      byType,
      bySource,
      favoriteCount: favRow?.c ?? 0,
      lastScanAt: new Date(),
    };
  }
}
