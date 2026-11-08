import { readFile, writeFile } from 'node:fs/promises';
import type {
  VaultEntry,
  ParserResult,
  ParseError,
  EntryType,
  EntrySource,
} from '../types/index.js';
import { generateId } from '../parsers/utils.js';
import { assertRemoteUrl, SafeFetchError, safeFetchText } from '../net/safe-fetch.js';

const VALID_TYPES: ReadonlySet<string> = new Set<EntryType>([
  'skill',
  'agent',
  'command',
  'plugin',
  'rule',
  'hook',
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<EntrySource>([
  'gstack',
  'bmad',
  'mindforge',
  'superpowers',
  'official',
  'community',
  'custom',
  'cursor',
  'copilot',
  'windsurf',
  'aider',
  'continue',
]);

/** Throws {@link SafeFetchError} unless `url` may be fetched; the policy lives in `net/`. */
export function validateUrl(url: string): void {
  assertRemoteUrl(url);
}

export interface ImportFromUrlOptions {
  /** Hosts whose private addresses the user accepts (config.json `allowPrivateHosts`). */
  readonly allowPrivateHosts?: readonly string[];
}

/** The one line a failed fetch becomes; nothing the remote end sent is in it. */
function describeFetchFailure(err: unknown): string {
  if (!(err instanceof SafeFetchError)) {
    return `Fetch failed: ${(err as Error).message}`;
  }
  switch (err.code) {
    case 'invalid_url':
      return `URL validation failed: ${err.message}`;
    case 'headers_timeout':
    case 'idle_timeout':
    case 'total_timeout':
      return `Request timed out (${err.message})`;
    default:
      return err.message;
  }
}

export interface VaultExportBundle {
  readonly version: string;
  readonly exportedAt: string;
  readonly source: string;
  readonly totalEntries: number;
  readonly entries: readonly ExportedEntry[];
}

export interface ExportedEntry {
  readonly name: string;
  readonly type: VaultEntry['type'];
  readonly source: VaultEntry['source'];
  readonly description: string;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
}

export function exportEntries(
  entries: readonly VaultEntry[],
  sourceName: string,
): VaultExportBundle {
  const exported: ExportedEntry[] = entries.map((e) => ({
    name: e.name,
    type: e.type,
    source: e.source,
    description: e.description,
    tags: e.tags,
    metadata: e.metadata,
    content: e.content,
  }));

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    source: sourceName,
    totalEntries: exported.length,
    entries: exported,
  };
}

export async function exportToFile(
  entries: readonly VaultEntry[],
  outputPath: string,
  sourceName: string,
  pretty = false,
): Promise<number> {
  const bundle = exportEntries(entries, sourceName);
  const json = pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
  await writeFile(outputPath, json, 'utf-8');
  return bundle.totalEntries;
}

export async function importFromFile(filePath: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      entries: [],
      errors: [{ filePath, message: `Cannot read file: ${(err as Error).message}` }],
    };
  }

  let bundle: VaultExportBundle;
  try {
    bundle = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      errors: [{ filePath, message: 'Invalid JSON format' }],
    };
  }

  if (!bundle.version || !Array.isArray(bundle.entries)) {
    return {
      entries: [],
      errors: [
        {
          filePath,
          message: 'Not a valid CommandVault export bundle (missing version or entries)',
        },
      ],
    };
  }

  for (const exported of bundle.entries) {
    if (!exported.name || !exported.type) {
      errors.push({
        filePath,
        message: `Skipping invalid entry: missing name or type`,
      });
      continue;
    }

    if (!VALID_TYPES.has(exported.type)) {
      errors.push({
        filePath,
        message: `Invalid entry type "${exported.type}" for "${exported.name}"`,
      });
      continue;
    }

    const validatedSource: EntrySource = VALID_SOURCES.has(exported.source)
      ? (exported.source as EntrySource)
      : 'custom';

    const entry: VaultEntry = {
      id: generateId(`import:${bundle.source}:${exported.name}`),
      name: exported.name,
      type: exported.type as EntryType,
      source: validatedSource,
      description: exported.description ?? '',
      filePath: `imported:${filePath}`,
      tags: [...(exported.tags ?? []), 'imported', `from:${bundle.source}`],
      metadata: {
        ...(exported.metadata ?? {}),
        importedFrom: bundle.source,
        importedAt: new Date().toISOString(),
        originalExportDate: bundle.exportedAt,
      },
      content: exported.content ?? '',
      lastModified: new Date(),
      favorite: false,
      usageCount: 0,
    };

    entries.push(entry);
  }

  return { entries, errors };
}

/** JSON.parse yields any value; only a non-null object has fields to read. */
function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}

export async function importFromUrl(
  url: string,
  options: ImportFromUrlOptions = {},
): Promise<ParserResult> {
  let text: string;
  try {
    ({ text } = await safeFetchText(url, { allowPrivateHosts: options.allowPrivateHosts }));
  } catch (err) {
    return {
      entries: [],
      errors: [{ filePath: url, message: describeFetchFailure(err) }],
    };
  }

  let bundle: VaultExportBundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    return {
      entries: [],
      errors: [{ filePath: url, message: 'Remote response is not valid JSON' }],
    };
  }

  // Any JSON value parses: `null` and non-objects have no fields to read, and a `null` entry
  // has no name. Both stay a ParserResult error or a skipped entry, never a thrown TypeError.
  if (!isObject(bundle) || !bundle.version || !Array.isArray(bundle.entries)) {
    return {
      entries: [],
      errors: [{ filePath: url, message: 'Remote response is not a valid CommandVault bundle' }],
    };
  }

  const validEntries = bundle.entries.filter(
    (e) => isObject(e) && e.name && e.type && VALID_TYPES.has(e.type),
  );

  const entries: VaultEntry[] = validEntries.map((exported) => ({
    id: generateId(`sync:${url}:${exported.name}`),
    name: exported.name,
    type: exported.type as EntryType,
    source: (VALID_SOURCES.has(exported.source) ? exported.source : 'community') as EntrySource,
    description: exported.description ?? '',
    filePath: `synced:${url}`,
    // Only an array may be spread: an object, number or boolean would throw a TypeError out of
    // this function (breaking the ParserResult contract) and a string would become its characters.
    tags: [
      ...(Array.isArray(exported.tags) ? exported.tags : []),
      'synced',
      `from:${new URL(url).hostname}`,
    ],
    metadata: {
      ...(exported.metadata ?? {}),
      syncedFrom: url,
      syncedAt: new Date().toISOString(),
    },
    content: exported.content ?? '',
    lastModified: new Date(),
    favorite: false,
    usageCount: 0,
  }));

  return { entries, errors: [] };
}
