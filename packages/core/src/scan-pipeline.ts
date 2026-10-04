import type { ParseError, ParserResult, VaultEntry } from './types/index.js';
import { KNOWN_ENTRY_TYPES } from './constants.js';

/** Prefix of the ParseError raised when two entries would share one id. */
export const DUPLICATE_ID_PREFIX = 'duplicate id ';

const STRING_FIELDS = ['id', 'name', 'source', 'description', 'filePath', 'content'] as const;

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns why `value` cannot be stored in the vault, or null when it is a usable VaultEntry.
 * The index layer calls toISOString()/join() on these fields, so a bad record must be stopped here
 * rather than throwing out of a scan.
 */
export function validateEntry(value: unknown): string | null {
  if (!isRecord(value)) return 'record is not an object';

  for (const field of STRING_FIELDS) {
    if (typeof value[field] !== 'string') return `"${field}" must be a string`;
  }
  if (value.id === '') return '"id" must not be empty';
  if (!KNOWN_ENTRY_TYPES.includes(value.type as string)) return `unknown type "${value.type}"`;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')) {
    return '"tags" must be an array of strings';
  }
  if (!isRecord(value.metadata)) return '"metadata" must be an object';
  if (!(value.lastModified instanceof Date) || Number.isNaN(value.lastModified.getTime())) {
    return '"lastModified" must be a valid Date';
  }
  if (typeof value.favorite !== 'boolean') return '"favorite" must be a boolean';
  if (typeof value.usageCount !== 'number') return '"usageCount" must be a number';
  return null;
}

/** Splits a batch into usable entries and one ParseError per rejected record. */
export function partitionValidEntries(
  records: readonly unknown[],
  parser: string,
): { readonly valid: VaultEntry[]; readonly errors: ParseError[] } {
  if (!Array.isArray(records)) {
    return {
      valid: [],
      errors: [{ filePath: '', parser, message: `Rejected ${parser} batch: not an array` }],
    };
  }

  const valid: VaultEntry[] = [];
  const errors: ParseError[] = [];
  records.forEach((record, index) => {
    const reason = validateEntry(record);
    if (reason === null) {
      valid.push(record as VaultEntry);
      return;
    }
    const filePath = isRecord(record) && typeof record.filePath === 'string' ? record.filePath : '';
    errors.push({ filePath, parser, message: `Rejected ${parser} record #${index}: ${reason}` });
  });
  return { valid, errors };
}

/**
 * Runs one parser so that nothing it does can reject the caller: a synchronous throw, a rejected
 * promise, a malformed result or a malformed entry each become a ParseError attributed to `parser`.
 * Entries from other parsers are unaffected.
 */
export async function runParserSafely(
  parser: string,
  filePath: string,
  run: () => Promise<ParserResult> | ParserResult,
): Promise<ParserResult> {
  let result: unknown;
  try {
    result = await run();
  } catch (cause) {
    return {
      entries: [],
      errors: [
        {
          filePath,
          parser,
          message: `Parser "${parser}" failed: ${describeFailure(cause)}`,
          cause,
        },
      ],
    };
  }

  if (!isRecord(result) || !Array.isArray(result.entries)) {
    return {
      entries: [],
      errors: [{ filePath, parser, message: `Parser "${parser}" returned a malformed result` }],
    };
  }

  const { valid, errors: rejected } = partitionValidEntries(result.entries, parser);
  const reported = Array.isArray(result.errors) ? (result.errors as ParseError[]) : [];
  return { entries: valid, errors: [...reported, ...rejected] };
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Enforces id uniqueness in one place. The first entry by sorted filePath wins (input order breaks
 * ties, so the outcome never depends on async parser completion order); every loser yields a
 * ParseError. Survivors keep their input order. Input is not modified.
 */
export function dedupeEntriesById(entries: readonly VaultEntry[]): {
  readonly entries: VaultEntry[];
  readonly errors: ParseError[];
} {
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareCodeUnits(a.entry.filePath, b.entry.filePath) || a.index - b.index);

  const winnerById = new Map<string, VaultEntry>();
  const survivingIndexes = new Set<number>();
  const errors: ParseError[] = [];

  for (const { entry, index } of ranked) {
    const winner = winnerById.get(entry.id);
    if (!winner) {
      winnerById.set(entry.id, entry);
      survivingIndexes.add(index);
      continue;
    }
    errors.push({
      filePath: entry.filePath,
      parser: entry.type,
      message: `${DUPLICATE_ID_PREFIX}${entry.id}: ${winner.filePath} vs ${entry.filePath}`,
    });
  }

  return { entries: entries.filter((_, index) => survivingIndexes.has(index)), errors };
}

/** True when `errors` records a dropped duplicate for `parser`, so its dropped entries are stale. */
export function hasDuplicateIdError(errors: readonly ParseError[], parser: string): boolean {
  return errors.some((e) => e.parser === parser && e.message.startsWith(DUPLICATE_ID_PREFIX));
}
