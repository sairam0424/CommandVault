import { readFile, readdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type { VaultEntry, ParserResult, ParseError, ParsedFrontmatter } from '../types/index.js';
import {
  generateStableId,
  parseFrontmatter,
  getLastModified,
  inferSource,
  extractTags,
} from './utils.js';
import { withRetry } from './retry.js';

export interface ParseContext {
  readonly folderName: string;
  readonly fileName: string;
  readonly filePath: string;
}

export interface ParseConfig {
  readonly type: string;
  readonly filePattern: RegExp;
  readonly extractMetadata?: (
    data: ParsedFrontmatter,
    content: string,
    context: ParseContext,
  ) => Record<string, unknown>;
  readonly nameFromPath?: (folderName: string, data: ParsedFrontmatter, context: ParseContext) => string;
  readonly descriptionFromContent?: (
    data: ParsedFrontmatter,
    content: string,
    context: ParseContext,
  ) => string;
  readonly postProcessTags?: (tags: string[], data: ParsedFrontmatter) => string[];
  readonly idDisambiguator?: (name: string, filePath: string) => string;
  readonly scanMode: 'files' | 'subdirs' | 'walk';
  readonly dirNotFoundMessage: string;
  readonly useRetry?: boolean;
  readonly skipEnoent?: boolean;
}

async function parseFileEntry(
  filePath: string,
  folderName: string,
  fileName: string,
  config: ParseConfig,
): Promise<VaultEntry> {
  const raw = config.useRetry
    ? await withRetry(() => readFile(filePath, 'utf-8'))
    : await readFile(filePath, 'utf-8');
  const { data, content } = parseFrontmatter(raw);
  const context: ParseContext = { folderName, fileName, filePath };
  const name = config.nameFromPath
    ? config.nameFromPath(folderName, data, context)
    : (data.name ?? basename(fileName, '.md'));
  const description = config.descriptionFromContent
    ? config.descriptionFromContent(data, content, context)
    : (typeof data.description === 'string' ? data.description.trim() : '');
  const source = inferSource(name, filePath);
  let tags = extractTags(name, description, data);
  if (config.postProcessTags) {
    tags = config.postProcessTags(tags, data);
  }
  const lastModified = await getLastModified(filePath);
  const disambiguator = config.idDisambiguator
    ? config.idDisambiguator(name, filePath)
    : source;
  const metadata = config.extractMetadata
    ? config.extractMetadata(data, content, context)
    : {};

  return {
    id: generateStableId(config.type, name, disambiguator),
    name,
    type: config.type as VaultEntry['type'],
    source,
    description,
    filePath,
    tags,
    metadata,
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}

async function walkDir(dir: string, pattern: RegExp): Promise<string[]> {
  const results: string[] = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      const nested = await walkDir(fullPath, pattern);
      results.push(...nested);
    } else if (pattern.test(item.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function parseMarkdownDir(
  dir: string,
  config: ParseConfig,
): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  if (config.scanMode === 'walk') {
    let files: string[];
    try {
      files = await walkDir(dir, config.filePattern);
    } catch {
      return {
        entries: [],
        errors: [{ filePath: dir, message: config.dirNotFoundMessage }],
      };
    }

    const parsePromises = files.map(async (filePath) => {
      const fileName = basename(filePath);
      const folderName = basename(dirname(filePath));
      try {
        const entry = await parseFileEntry(filePath, folderName, fileName, config);
        entries.push(entry);
      } catch (err) {
        errors.push({
          filePath,
          message: `Failed to parse ${config.type}: ${(err as Error).message}`,
          cause: err,
        });
      }
    });

    await Promise.all(parsePromises);
    return { entries, errors };
  }

  if (config.scanMode === 'subdirs') {
    let dirs: string[];
    try {
      dirs = await readdir(dir);
    } catch {
      return {
        entries: [],
        errors: [{ filePath: dir, message: config.dirNotFoundMessage }],
      };
    }

    const parsePromises = dirs.map(async (folderName) => {
      const candidates = await readdir(join(dir, folderName)).catch(
        () => [] as string[],
      );
      const matchedFile = candidates.find((f) => config.filePattern.test(f));
      if (!matchedFile) return;

      const filePath = join(dir, folderName, matchedFile);
      try {
        const entry = await parseFileEntry(filePath, folderName, matchedFile, config);
        entries.push(entry);
      } catch (err) {
        const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (config.skipEnoent && isNotFound) return;
        if (!isNotFound) {
          errors.push({
            filePath,
            message: `Failed to parse ${config.type}: ${(err as Error).message}`,
            cause: err,
          });
        }
      }
    });

    await Promise.all(parsePromises);
  } else {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => config.filePattern.test(f));
    } catch {
      return {
        entries: [],
        errors: [{ filePath: dir, message: config.dirNotFoundMessage }],
      };
    }

    const parsePromises = files.map(async (file) => {
      const filePath = join(dir, file);
      try {
        const entry = await parseFileEntry(filePath, basename(dir), file, config);
        entries.push(entry);
      } catch (err) {
        errors.push({
          filePath,
          message: `Failed to parse ${config.type}: ${(err as Error).message}`,
          cause: err,
        });
      }
    });

    await Promise.all(parsePromises);
  }

  return { entries, errors };
}
