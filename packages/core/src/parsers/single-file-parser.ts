import { readFile } from 'node:fs/promises';
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

const MARKDOWN_PARSEABLE_TYPES = new Set<EntryType>(['skill', 'agent', 'rule', 'command']);

export function isSingleFileParseable(parserType: EntryType): boolean {
  return MARKDOWN_PARSEABLE_TYPES.has(parserType);
}

export async function parseSingleFile(
  filePath: string,
  parserType: EntryType,
): Promise<VaultEntry | null> {
  if (!isSingleFileParseable(parserType)) {
    return null;
  }

  try {
    const raw = await withRetry(() => readFile(filePath, 'utf-8'));
    const lastModified = await getLastModified(filePath);
    const { data, content } = parseFrontmatter(raw);

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
  } catch {
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
  const description = typeof data.description === 'string' ? data.description.trim() : '';
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
  const description = typeof data.description === 'string' ? data.description.trim() : '';
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
  const firstLine = content.split('\n').find((l) => l.startsWith('# '));
  const description =
    typeof data.description === 'string'
      ? data.description.trim()
      : (firstLine?.replace(/^#\s+/, '') ?? `Rule: ${name}`);
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
  const description = typeof data.description === 'string' ? data.description.trim() : '';
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
    },
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}
