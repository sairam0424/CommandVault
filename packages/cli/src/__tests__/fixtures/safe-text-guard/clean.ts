import type { VaultEntry } from '@commandvault/core';
import { jsonOutput } from '../../../helpers.js';
import { safeText, toDisplay } from '../../../ui/safe-text.js';

/** Self-test fixture for safe-text-guard.test.ts: every read here is cleared or not text. */
export function show(entry: VaultEntry, entries: readonly VaultEntry[]): readonly string[] {
  jsonOutput({ entries });
  return [safeText(entry.name), toDisplay(entry).name, String(entry.usageCount), entry.type];
}
