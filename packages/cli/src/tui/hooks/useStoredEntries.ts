import { useCallback, useMemo, useState } from 'react';
import type { SearchResult, Vault, VaultEntry } from '@commandvault/core';

export interface StoredEntries {
  /** The results, with the rows that are drawn read back from the vault. */
  readonly shown: SearchResult[];
  /** One entry as the vault holds it right now; the entry itself when the vault has no record. */
  readonly stored: (entry: VaultEntry) => VaultEntry;
  /** Reads the drawn rows again, after something changed an entry (a favorite, a usage count). */
  readonly refresh: () => void;
}

/**
 * The search tiers the TUI uses hand back what the parsers produced: no favorite, no usage count,
 * and (fuzzy tier) only the start of the content. The vault's own record of an entry has all of
 * it, so the rows on screen and the entry under the selection are read from there. Only the drawn
 * rows are read, so a long list costs no more than a short one.
 */
export function useStoredEntries(
  vault: Vault,
  results: SearchResult[],
  scrollTop: number,
  visibleCount: number,
): StoredEntries {
  const [version, setVersion] = useState(0);

  const stored = useCallback(
    (entry: VaultEntry): VaultEntry => vault.getEntry(entry.id) ?? entry,
    [vault],
  );

  const shown = useMemo(() => {
    // `version` is read so a refresh re-reads the rows even when nothing else changed.
    void version;
    const end = scrollTop + visibleCount;
    return results.map((result, index) =>
      index >= scrollTop && index < end ? { ...result, entry: stored(result.entry) } : result,
    );
  }, [results, scrollTop, visibleCount, stored, version]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  return { shown, stored, refresh };
}
