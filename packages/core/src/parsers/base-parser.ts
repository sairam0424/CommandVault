import { readdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type { VaultEntry, ParserResult, ParseError, ParsedFrontmatter } from '../types/index.js';
import {
  generateStableId,
  parseFrontmatter,
  getLastModified,
  inferSource,
  extractTags,
  type FrontmatterRecovery,
} from './utils.js';
import { withRetry } from './retry.js';
import { describeFileFailure, readBoundedText } from './bounded-read.js';
import { followFileLinks, linkMetadata, linkTags, type ResolvedRead } from './link-policy.js';
import { FrontmatterSkippedError } from './frontmatter-recovery.js';
import { truncatedFrontmatterWarning } from './sanitize-frontmatter.js';
import {
  deriveDescription,
  descriptionMetadata,
  type DerivedDescription,
} from './body-description.js';

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
  readonly nameFromPath?: (
    folderName: string,
    data: ParsedFrontmatter,
    context: ParseContext,
  ) => string;
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

interface ParsedFile {
  readonly entry: VaultEntry;
  readonly warnings: readonly ParseError[];
}

// Surfaced as a tag so a lossy frontmatter recovery is visible in search and the UI.
export const FRONTMATTER_WARNING_TAG = 'frontmatter-warning';

export function describeRecoveryWarning(
  type: string,
  filePath: string,
  recovery: FrontmatterRecovery,
  cause: unknown,
): ParseError {
  const reason = (cause as Error | undefined)?.message?.split('\n')[0] ?? 'invalid YAML';
  return {
    filePath,
    message: `Recovered ${type} frontmatter via ${recovery} fallback (name/description only): ${reason}`,
    severity: 'warning',
    cause,
  };
}

/**
 * The warning for a file whose frontmatter the guard skipped (too big, or too many aliases). The
 * agent-config parsers use it, since they keep ordinary recoveries silent; an empty list for any
 * other cause.
 */
export function skippedFrontmatterWarnings(
  label: string,
  filePath: string,
  cause: unknown,
): readonly ParseError[] {
  if (!(cause instanceof FrontmatterSkippedError)) return [];
  return [describeRecoveryWarning(label, filePath, 'line-based', cause)];
}

function readSource(filePath: string, config: ParseConfig): Promise<string> {
  return config.useRetry ? withRetry(() => readBoundedText(filePath)) : readBoundedText(filePath);
}

function resolveDescription(
  data: ParsedFrontmatter,
  content: string,
  context: ParseContext,
  config: ParseConfig,
): DerivedDescription {
  if (config.descriptionFromContent) {
    return { text: config.descriptionFromContent(data, content, context), fromBody: false };
  }
  return deriveDescription(data, content);
}

function resolveTags(
  name: string,
  description: string,
  data: ParsedFrontmatter,
  recovery: FrontmatterRecovery | undefined,
  config: ParseConfig,
  link: ResolvedRead,
): string[] {
  const extracted = extractTags(name, description, data);
  const tags = config.postProcessTags ? config.postProcessTags(extracted, data) : extracted;
  const recovered = recovery ? [...tags, FRONTMATTER_WARNING_TAG] : tags;
  return [...recovered, ...linkTags(link)];
}

function fileWarnings(
  filePath: string,
  config: ParseConfig,
  recovery: FrontmatterRecovery | undefined,
  recoveryCause: unknown,
  dropped: number | undefined,
): readonly ParseError[] {
  return [
    ...(recovery === 'line-based'
      ? [describeRecoveryWarning(config.type, filePath, recovery, recoveryCause)]
      : []),
    ...(dropped ? [truncatedFrontmatterWarning(config.type, filePath, dropped)] : []),
  ];
}

async function parseFileEntry(
  filePath: string,
  folderName: string,
  fileName: string,
  config: ParseConfig,
): Promise<ParsedFile> {
  const link = await followFileLinks(filePath);
  const raw = await readSource(link.readPath, config);
  const { data, content, recovery, recoveryCause, dropped } = parseFrontmatter(raw);
  const context: ParseContext = { folderName, fileName, filePath };
  const name = config.nameFromPath
    ? config.nameFromPath(folderName, data, context)
    : (data.name ?? basename(fileName, '.md'));
  const derived = resolveDescription(data, content, context, config);
  const description = derived.text;
  const source = inferSource(name, filePath);
  const disambiguator = config.idDisambiguator ? config.idDisambiguator(name, filePath) : source;
  const parsedMetadata = config.extractMetadata
    ? config.extractMetadata(data, content, context)
    : {};
  const metadata = {
    ...parsedMetadata,
    ...(recovery ? { frontmatterRecovery: recovery } : {}),
    ...linkMetadata(link),
    ...descriptionMetadata(derived),
  };
  const warnings = fileWarnings(filePath, config, recovery, recoveryCause, dropped);

  const entry: VaultEntry = {
    id: generateStableId(config.type, name, disambiguator),
    name,
    type: config.type as VaultEntry['type'],
    source,
    description,
    filePath,
    tags: resolveTags(name, description, data, recovery, config, link),
    metadata,
    content,
    lastModified: await getLastModified(link.readPath),
    favorite: false,
    usageCount: 0,
  };
  return { entry, warnings };
}

function describeParseFailure(err: unknown, filePath: string, config: ParseConfig): ParseError {
  return describeFileFailure(
    err,
    filePath,
    `Failed to parse ${config.type}`,
    `${config.type} file`,
  );
}

function directoryNotFound(dir: string, config: ParseConfig): ParseError {
  return { filePath: dir, message: config.dirNotFoundMessage, severity: 'error' };
}

function unreadableDirectory(dir: string, cause: unknown): ParseError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return {
    filePath: dir,
    message: `Skipped unreadable directory ${dir}: ${reason}`,
    severity: 'warning',
    cause,
  };
}

function collectParsed(parsed: ParsedFile, entries: VaultEntry[], errors: ParseError[]): void {
  entries.push(parsed.entry);
  errors.push(...parsed.warnings);
}

/**
 * Every file under `dir` matching `pattern`. Only the top directory failing to list propagates: a
 * subdirectory that cannot be read costs its own files and one warning, never its siblings.
 */
async function walkDir(dir: string, pattern: RegExp, warnings: ParseError[]): Promise<string[]> {
  const results: string[] = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      try {
        results.push(...(await walkDir(fullPath, pattern, warnings)));
      } catch (err) {
        warnings.push(unreadableDirectory(fullPath, err));
      }
    } else if (pattern.test(item.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function parseMarkdownDir(dir: string, config: ParseConfig): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  if (config.scanMode === 'walk') {
    let files: string[];
    try {
      files = await walkDir(dir, config.filePattern, errors);
    } catch {
      return {
        entries: [],
        errors: [directoryNotFound(dir, config)],
      };
    }

    const parsePromises = files.map(async (filePath) => {
      const fileName = basename(filePath);
      const folderName = basename(dirname(filePath));
      try {
        const parsed = await parseFileEntry(filePath, folderName, fileName, config);
        collectParsed(parsed, entries, errors);
      } catch (err) {
        errors.push(describeParseFailure(err, filePath, config));
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
        errors: [directoryNotFound(dir, config)],
      };
    }

    const parsePromises = dirs.map(async (folderName) => {
      const candidates = await readdir(join(dir, folderName)).catch(() => [] as string[]);
      const matchedFile = candidates.find((f) => config.filePattern.test(f));
      if (!matchedFile) return;

      const filePath = join(dir, folderName, matchedFile);
      try {
        const parsed = await parseFileEntry(filePath, folderName, matchedFile, config);
        collectParsed(parsed, entries, errors);
      } catch (err) {
        const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (config.skipEnoent && isNotFound) return;
        if (!isNotFound) {
          errors.push(describeParseFailure(err, filePath, config));
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
        errors: [directoryNotFound(dir, config)],
      };
    }

    const parsePromises = files.map(async (file) => {
      const filePath = join(dir, file);
      try {
        const parsed = await parseFileEntry(filePath, basename(dir), file, config);
        collectParsed(parsed, entries, errors);
      } catch (err) {
        errors.push(describeParseFailure(err, filePath, config));
      }
    });

    await Promise.all(parsePromises);
  }

  return { entries, errors };
}
