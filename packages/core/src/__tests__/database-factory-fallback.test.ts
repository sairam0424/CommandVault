import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseAdapter } from '../indexer/database-factory.js';
import { SqlJsAdapter } from '../indexer/sqljs-adapter.js';

// When better-sqlite3 cannot even be imported (not installed, no native build shipped), the
// factory uses the pure-JS sql.js backend. Only a driver that cannot be imported at all does this;
// a driver that imports but fails to open the database reports its error instead (see
// db-open-native-addon.test.ts).
vi.mock('better-sqlite3', () => {
  throw new Error("Cannot find module 'better-sqlite3'");
});

describe('createDatabaseAdapter when better-sqlite3 cannot be imported', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cv-factory-fallback-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the sql.js adapter', async () => {
    const adapter = await createDatabaseAdapter(join(dir, 'vault.db'));

    expect(adapter).toBeInstanceOf(SqlJsAdapter);
    adapter.close();
  });
});
