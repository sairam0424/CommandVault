import type { VaultEntry } from '../types/index.js';

export interface QualityScore {
  readonly entry: VaultEntry;
  readonly score: number;
  readonly breakdown: {
    readonly recency: number;
    readonly usage: number;
    readonly completeness: number;
    readonly engagement: number;
  };
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function scoreRecency(entry: VaultEntry): number {
  const daysAgo = Math.floor((Date.now() - entry.lastModified.getTime()) / MS_PER_DAY);
  if (daysAgo <= 0) return 25;
  if (daysAgo <= 7) return 20;
  if (daysAgo <= 30) return 15;
  if (daysAgo <= 90) return 10;
  if (daysAgo <= 365) return 5;
  return 0;
}

function scoreUsage(entry: VaultEntry, maxUsageCount: number): number {
  if (maxUsageCount === 0) return 0;
  return Math.round((entry.usageCount / maxUsageCount) * 25);
}

function scoreCompleteness(entry: VaultEntry): number {
  let score = 0;
  if (entry.description.length > 10) score += 8;
  if (entry.tags.length >= 1) score += 5;
  if (entry.tags.length >= 3) score += 4;
  if (entry.content.length > 50) score += 8;
  return score;
}

function scoreEngagement(entry: VaultEntry): number {
  let score = 0;
  if (entry.favorite) score += 15;
  if (entry.usageCount > 0) score += 10;
  return score;
}

export function scoreEntries(entries: readonly VaultEntry[]): QualityScore[] {
  const maxUsageCount = entries.reduce((max, e) => Math.max(max, e.usageCount), 0);

  const scores = entries.map((entry): QualityScore => {
    const recency = scoreRecency(entry);
    const usage = scoreUsage(entry, maxUsageCount);
    const completeness = scoreCompleteness(entry);
    const engagement = scoreEngagement(entry);

    return {
      entry,
      score: recency + usage + completeness + engagement,
      breakdown: { recency, usage, completeness, engagement },
    };
  });

  return [...scores].sort((a, b) => b.score - a.score);
}
