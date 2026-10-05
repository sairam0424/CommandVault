import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { VaultEntry } from '../types/index.js';

export interface StalenessResult {
  readonly entry: VaultEntry;
  readonly daysSinceModified: number;
  readonly sourceFileExists: boolean;
  readonly isStale: boolean;
}

export interface StalenessOptions {
  /**
   * The settings.json that defines hook entries. A hook's own `filePath` is the script or command
   * line it runs, which is often not a file at all, so a hook without a script file is judged by
   * this file instead. Without it such a hook has no source to check and is reported as missing.
   */
  readonly settingsPath?: string;
}

const BATCH_SIZE = 50;
/** The hook parser takes the first `.js` token of a command as the script; anything else is a command line. */
const HOOK_SCRIPT_SUFFIX = '.js';
const MS_PER_DAY = 1000 * 60 * 60 * 24;

async function modifiedAt(path: string): Promise<Date | undefined> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return undefined;
  }
}

/**
 * The file whose age decides staleness: the entry's own file. A hook is judged by its script when
 * the script is a real path: an absolute one stays missing when it is gone (that dangling script
 * is what an audit has to flag), a relative one is looked for in the settings directory, where the
 * hook parser also looks. Everything else (a command line, a `~` or `$VAR` path, a script the
 * settings directory does not hold) cannot be located without the shell that runs it, so it is
 * judged by settings.json, never by the current directory.
 */
async function sourceModifiedAt(
  entry: VaultEntry,
  options: StalenessOptions,
): Promise<Date | undefined> {
  const { settingsPath } = options;
  const namesScript = entry.filePath.endsWith(HOOK_SCRIPT_SUFFIX);
  if (entry.type !== 'hook' || settingsPath === undefined) return modifiedAt(entry.filePath);
  if (namesScript && isAbsolute(entry.filePath)) return modifiedAt(entry.filePath);
  const inSettingsDir = namesScript
    ? await modifiedAt(resolve(dirname(settingsPath), entry.filePath))
    : undefined;
  return inSettingsDir ?? modifiedAt(settingsPath);
}

async function checkEntry(
  entry: VaultEntry,
  thresholdDays: number,
  options: StalenessOptions,
): Promise<StalenessResult> {
  const modified = await sourceModifiedAt(entry, options);
  if (modified === undefined) {
    return {
      entry,
      daysSinceModified: Infinity,
      sourceFileExists: false,
      isStale: true,
    };
  }
  const daysSinceModified = Math.floor((Date.now() - modified.getTime()) / MS_PER_DAY);
  return {
    entry,
    daysSinceModified,
    sourceFileExists: true,
    isStale: daysSinceModified > thresholdDays,
  };
}

export async function detectStaleness(
  entries: readonly VaultEntry[],
  thresholdDays: number = 30,
  options: StalenessOptions = {},
): Promise<StalenessResult[]> {
  const results: StalenessResult[] = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((entry) => checkEntry(entry, thresholdDays, options)),
    );
    results.push(...batchResults);
  }

  return [...results].sort((a, b) => {
    if (a.daysSinceModified === Infinity && b.daysSinceModified === Infinity) return 0;
    if (a.daysSinceModified === Infinity) return -1;
    if (b.daysSinceModified === Infinity) return -1;
    return b.daysSinceModified - a.daysSinceModified;
  });
}
