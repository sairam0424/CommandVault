import { readFile, writeFile } from 'node:fs/promises';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateId } from '../parsers/utils.js';

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
  sourceName: string
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
  pretty = false
): Promise<number> {
  const bundle = exportEntries(entries, sourceName);
  const json = pretty
    ? JSON.stringify(bundle, null, 2)
    : JSON.stringify(bundle);
  await writeFile(outputPath, json, 'utf-8');
  return bundle.totalEntries;
}

export async function importFromFile(
  filePath: string
): Promise<ParserResult> {
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
      errors: [{ filePath, message: 'Not a valid CommandVault export bundle (missing version or entries)' }],
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

    const entry: VaultEntry = {
      id: generateId(`import:${bundle.source}:${exported.name}`),
      name: exported.name,
      type: exported.type,
      source: exported.source ?? 'custom',
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

export async function importFromUrl(
  url: string
): Promise<ParserResult> {
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

    const entries: VaultEntry[] = bundle.entries
      .filter((e) => e.name && e.type)
      .map((exported) => ({
        id: generateId(`sync:${url}:${exported.name}`),
        name: exported.name,
        type: exported.type,
        source: exported.source ?? 'community',
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
