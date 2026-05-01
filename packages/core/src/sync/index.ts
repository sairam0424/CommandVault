import { readFile, writeFile } from 'node:fs/promises';
import type {
  VaultEntry,
  ParserResult,
  ParseError,
  EntryType,
  EntrySource,
} from '../types/index.js';
import { generateId } from '../parsers/utils.js';

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

function validateUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  const blockedPatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^\[::1\]$/,
    /^\[fe80:/i,
  ];
  if (blockedPatterns.some((p) => p.test(hostname))) {
    throw new Error(`Blocked: private/internal URL ${hostname}`);
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

export async function importFromUrl(url: string): Promise<ParserResult> {
  try {
    validateUrl(url);
  } catch (err) {
    return {
      entries: [],
      errors: [{ filePath: url, message: `URL validation failed: ${(err as Error).message}` }],
    };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        entries: [],
        errors: [{ filePath: url, message: `HTTP ${response.status}: ${response.statusText}` }],
      };
    }
    const text = await response.text();
    const tempPath = `remote:${url}`;

    let bundle: VaultExportBundle;
    try {
      bundle = JSON.parse(text);
    } catch {
      return {
        entries: [],
        errors: [{ filePath: url, message: 'Remote response is not valid JSON' }],
      };
    }

    if (!bundle.version || !Array.isArray(bundle.entries)) {
      return {
        entries: [],
        errors: [{ filePath: url, message: 'Remote response is not a valid CommandVault bundle' }],
      };
    }

    const validEntries = bundle.entries.filter((e) => e.name && e.type && VALID_TYPES.has(e.type));

    const entries: VaultEntry[] = validEntries.map((exported) => ({
      id: generateId(`sync:${url}:${exported.name}`),
      name: exported.name,
      type: exported.type as EntryType,
      source: (VALID_SOURCES.has(exported.source) ? exported.source : 'community') as EntrySource,
      description: exported.description ?? '',
      filePath: `synced:${url}`,
      tags: [...(exported.tags ?? []), 'synced', `from:${new URL(url).hostname}`],
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
  } catch (err) {
    return {
      entries: [],
      errors: [{ filePath: url, message: `Fetch failed: ${(err as Error).message}` }],
    };
  }
}
