import { basename, dirname } from 'node:path';
import type { VaultEntry, EntryType } from '../types/index.js';
import {
  generateStableId,
  parseFrontmatter,
  getLastModified,
  inferSource,
  extractTags,
} from './utils.js';
import { withRetry } from './retry.js';
import { readBoundedText } from './bounded-read.js';
import { followFileLinks, withLinkFields } from './link-policy.js';
import { deriveDescription, descriptionMetadata } from './body-description.js';
import { deriveRuleDescription } from './rule-parser.js';

const MARKDOWN_PARSEABLE_TYPES = new Set<EntryType>(['skill', 'agent', 'rule', 'command']);

export function isSingleFileParseable(parserType: EntryType): boolean {
  return MARKDOWN_PARSEABLE_TYPES.has(parserType);
}

/**
 * The watcher's re-parse of one changed file. Null means the file yields no entry (unparseable,
 * skipped as oversized or not a regular file, or a link that cannot be followed): this path has no
 * warning channel, so the reason is not reported here.
 */
export async function parseSingleFile(
  filePath: string,
  parserType: EntryType,
): Promise<VaultEntry | null> {
  if (!isSingleFileParseable(parserType)) {
    return null;
  }

  try {
    const link = await followFileLinks(filePath);
    const raw = await withRetry(() => readBoundedText(link.readPath));
    const lastModified = await getLastModified(link.readPath);
    const { data, content } = parseFrontmatter(raw);
    const entry = buildEntry(parserType, filePath, data, content, lastModified);
    return entry === null ? null : withLinkFields(entry, link);
  } catch {
    return null;
  }
}

function buildEntry(
  parserType: EntryType,
  filePath: string,
  data: Record<string, unknown>,
  content: string,
  lastModified: Date,
): VaultEntry | null {
  switch (parserType) {
    case 'skill':
      return parseSkillFile(filePath, data, content, lastModified);
    case 'agent':
      return parseAgentFile(filePath, data, content, lastModified);
    case 'rule':
      return parseRuleFile(filePath, data, content, lastModified);
    case 'command':
      return parseCommandFile(filePath, data, content, lastModified);
    default:
      return null;
  }
}

function parseSkillFile(
  filePath: string,
  data: Record<string, unknown>,
  content: string,
  lastModified: Date,
): VaultEntry {
  const folderName = basename(dirname(filePath));
  const name = (data.name as string) ?? folderName;
  const derived = deriveDescription(data, content);
  const description = derived.text;
  const source = inferSource(name, filePath);
  const tags = extractTags(name, description, data);

  return {
    id: generateStableId('skill', name, source),
    name,
    type: 'skill',
    source,
    description,
    filePath,
    tags,
    metadata: {
      version: data.version,
      preambleTier: data.preambleTier ?? data['preamble-tier'],
      triggers: data.triggers,
      allowedTools: data.allowedTools ?? data['allowed-tools'],
      folderName,
      ...descriptionMetadata(derived),
    },
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}

function parseAgentFile(
  filePath: string,
  data: Record<string, unknown>,
  content: string,
  lastModified: Date,
): VaultEntry {
  const file = basename(filePath);
  const name = (data.name as string) ?? basename(file, '.md');
  const derived = deriveDescription(data, content);
  const description = derived.text;
  const source = inferSource(name, filePath);
  const tags = extractTags(name, description, data);

  return {
    id: generateStableId('agent', name, source),
    name,
    type: 'agent',
    source,
    description,
    filePath,
    tags,
    metadata: {
      color: data.color,
      emoji: data.emoji,
      vibe: data.vibe,
      fileName: file,
      ...descriptionMetadata(derived),
    },
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}

function parseRuleFile(
  filePath: string,
  data: Record<string, unknown>,
  content: string,
  lastModified: Date,
): VaultEntry {
  const file = basename(filePath);
  const name = (data.name as string) ?? basename(file, '.md').replace(/-/g, ' ');
  const description = deriveRuleDescription(data, content, file);
  const tags = extractTags(name, description, data);
  tags.push('rule');

  return {
    id: generateStableId('rule', name),
    name,
    type: 'rule',
    source: 'custom',
    description,
    filePath,
    tags,
    metadata: {
      fileName: file,
    },
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}

function parseCommandFile(
  filePath: string,
  data: Record<string, unknown>,
  content: string,
  lastModified: Date,
): VaultEntry {
  const parentDir = basename(dirname(filePath));
  const fileName = basename(filePath, '.md');
  const commandName = parentDir !== 'commands' ? `${parentDir}:${fileName}` : fileName;
  const name = (data.name as string) ?? commandName;
  const derived = deriveDescription(data, content);
  const description = derived.text;
  const source = inferSource(name, filePath);
  const tags = extractTags(name, description, data);

  return {
    id: generateStableId('command', name, source),
    name,
    type: 'command',
    source,
    description,
    filePath,
    tags,
    metadata: {
      namespace: parentDir !== 'commands' ? parentDir : undefined,
      fileName: basename(filePath),
      ...descriptionMetadata(derived),
    },
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}
