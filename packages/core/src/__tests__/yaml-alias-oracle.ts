import matter from 'gray-matter';

/**
 * An independent reading of what the real YAML engine does with a frontmatter block, for tests that
 * judge the alias guard. It shares nothing with the guard but gray-matter's own block slicing: the
 * aliases are counted by watching every lookup in js-yaml's anchor table (not by looking at node
 * kinds), and the size of the result is measured by expanding it as a tree, one visit per
 * reference, which is what `JSON.stringify` (and so the index step) pays.
 */

type YamlParse = (text: string, options?: object) => unknown;

interface LoaderState {
  anchorMap: Record<string, unknown>;
}

const YAML_ENGINES = (matter as unknown as { engines: { yaml: { parse: YamlParse } } }).engines;
const DISABLED_ENGINE = { parse: () => ({}) };

export interface OracleReading {
  /** False when the engine rejected the block (invalid YAML, an unknown alias, a JSON error). */
  readonly parsed: boolean;
  /** Alias nodes that resolved to something other than null or an empty string. */
  readonly valueAliases: number;
  /** The data the engine built, with its shared references intact. */
  readonly data: unknown;
}

function watchAnchorLookups(onLookup: () => void): (event: string, state: LoaderState) => void {
  let watching = false;
  return (event, state) => {
    if (event !== 'open' || watching) return;
    watching = true;
    state.anchorMap = new Proxy(state.anchorMap, {
      get(table, key, receiver) {
        const value: unknown = Reflect.get(table, key, receiver);
        const isLookup = typeof key === 'string' && Object.hasOwn(table, key);
        if (isLookup && value !== null && value !== undefined && value !== '') onLookup();
        return value;
      },
    });
  };
}

/** Parses `raw` the way gray-matter would, with no guard in the way, and counts the aliases. */
export function readWithOracle(raw: string): OracleReading {
  let valueAliases = 0;
  const listener = watchAnchorLookups(() => {
    valueAliases += 1;
  });
  const engines = {
    javascript: DISABLED_ENGINE,
    coffee: DISABLED_ENGINE,
    js: DISABLED_ENGINE,
    yaml: { parse: (text: string) => YAML_ENGINES.yaml.parse(text, { listener }) as object },
  };
  try {
    const { data } = matter(raw, { engines });
    return { parsed: true, valueAliases, data };
  } catch {
    return { parsed: false, valueAliases, data: undefined };
  }
}

/**
 * How many units the value is worth once every reference is expanded: one per node, plus the
 * characters of every string and key. Stops counting past `cap` (and calls a cycle past it), so a
 * 9^8 DAG costs a few thousand steps, not 43 million.
 */
export function expandedUnits(value: unknown, cap: number): number {
  const budget = { left: cap + 1 };
  const total = walk(value, new Set<object>(), budget);
  return Math.min(total, cap + 1);
}

function walk(value: unknown, ancestors: Set<object>, budget: { left: number }): number {
  if (budget.left <= 0) return 0;
  budget.left -= 1;
  if (typeof value === 'string') return spend(1 + value.length, budget);
  if (value === null || typeof value !== 'object' || value instanceof Date) return 1;
  if (ancestors.has(value)) {
    budget.left = 0;
    return Number.MAX_SAFE_INTEGER;
  }
  ancestors.add(value);
  let total = 1;
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  for (const [key, item] of entries) {
    if (!Array.isArray(value)) total += spend(1 + key.length, budget);
    total += walk(item, ancestors, budget);
    if (budget.left <= 0) break;
  }
  ancestors.delete(value);
  return total;
}

function spend(units: number, budget: { left: number }): number {
  budget.left -= units - 1;
  return units;
}

/** True when some value contains itself, which no tree walk (or `JSON.stringify`) can finish. */
export function hasCycle(value: unknown): boolean {
  return cycleBelow(value, new Set<object>(), new Set<object>());
}

function cycleBelow(value: unknown, ancestors: Set<object>, cleared: Set<object>): boolean {
  if (value === null || typeof value !== 'object' || value instanceof Date) return false;
  if (ancestors.has(value)) return true;
  if (cleared.has(value)) return false;
  ancestors.add(value);
  const found = Object.values(value).some((item) => cycleBelow(item, ancestors, cleared));
  ancestors.delete(value);
  cleared.add(value);
  return found;
}
