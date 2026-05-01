import { readFile, readdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import {
  generateId,
  parseFrontmatter,
  getLastModified,
  inferSource,
  extractTags,
} from './utils.js';

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      const nested = await walkDir(fullPath);
      results.push(...nested);
    } else if (item.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function parseCommands(commandsDir: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let files: string[];
  try {
    files = await walkDir(commandsDir);
  } catch {
    return {
      entries: [],
      errors: [{ filePath: commandsDir, message: 'Commands directory not found' }],
    };
  }

  const parsePromises = files.map(async (filePath) => {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      const parentDir = basename(dirname(filePath));
      const fileName = basename(filePath, '.md');
      const commandName = parentDir !== 'commands' ? `${parentDir}:${fileName}` : fileName;
      const name = data.name ?? commandName;
      const description = typeof data.description === 'string' ? data.description.trim() : '';
      const source = inferSource(name, filePath);
      const tags = extractTags(name, description, data);
      const lastModified = await getLastModified(filePath);

      const entry: VaultEntry = {
        id: generateId(filePath),
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
      entries.push(entry);
    } catch (err) {
      errors.push({
        filePath,
        message: `Failed to parse command: ${(err as Error).message}`,
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
