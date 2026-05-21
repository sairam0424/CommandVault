import { stat } from 'node:fs/promises';
import type { VaultEntry } from '../types/index.js';

export interface StalenessResult {
  readonly entry: VaultEntry;
  readonly daysSinceModified: number;
  readonly sourceFileExists: boolean;
  readonly isStale: boolean;
}

const BATCH_SIZE = 50;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

async function checkEntry(entry: VaultEntry, thresholdDays: number): Promise<StalenessResult> {
  try {
    const fileStat = await stat(entry.filePath);
    const daysSinceModified = Math.floor((Date.now() - fileStat.mtime.getTime()) / MS_PER_DAY);
    return {
      entry,
      daysSinceModified,
      sourceFileExists: true,
      isStale: daysSinceModified > thresholdDays,
    };
  } catch {
    return {
      entry,
      daysSinceModified: Infinity,
      sourceFileExists: false,
      isStale: true,
    };
  }
}

export async function detectStaleness(
  entries: readonly VaultEntry[],
  thresholdDays: number = 30,
): Promise<StalenessResult[]> {
  const results: StalenessResult[] = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((entry) => checkEntry(entry, thresholdDays)));
    results.push(...batchResults);
  }

  return [...results].sort((a, b) => {
    if (a.daysSinceModified === Infinity && b.daysSinceModified === Infinity) return 0;
    if (a.daysSinceModified === Infinity) return -1;
    if (b.daysSinceModified === Infinity) return -1;
    return b.daysSinceModified - a.daysSinceModified;
  });
}
