import type { SearchResult, RankingWeights } from '../types/index.js';

const DEFAULT_WEIGHTS: RankingWeights = {
  textRelevance: 0.55,
  recency: 0.15,
  usageFrequency: 0.2,
  favoriteBoost: 0.1,
};

const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function normalizeScore(
  results: readonly SearchResult[],
  weights?: Partial<RankingWeights>,
  query?: string,
): SearchResult[] {
  if (results.length === 0) return [];

  const w: RankingWeights = { ...DEFAULT_WEIGHTS, ...weights };

  const maxUsage = Math.max(1, ...results.map((r) => r.entry.usageCount));
  const now = Date.now();

  const scored = results.map((r) => {
    const textScore = Math.max(0, Math.min(1, r.score));

    const ageMs = now - r.entry.lastModified.getTime();
    const recencyScore = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);

    const usageScore = r.entry.usageCount / maxUsage;

    const favBonus = r.entry.favorite ? 1 : 0;

    const nameBonus = query && r.entry.name.toLowerCase().includes(query.toLowerCase()) ? 0.001 : 0;

    const finalScore =
      w.textRelevance * textScore +
      w.recency * recencyScore +
      w.usageFrequency * usageScore +
      w.favoriteBoost * favBonus +
      nameBonus;

    return {
      ...r,
      score: Math.max(0, Math.min(1, finalScore)),
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}
