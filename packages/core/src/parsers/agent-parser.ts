import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import {
  generateStableId,
  parseFrontmatter,
  getLastModified,
  inferSource,
  extractTags,
} from './utils.js';
import { withRetry } from './retry.js';

export async function parseAgents(agentsDir: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let files: string[];
  try {
    files = (await readdir(agentsDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return {
      entries: [],
      errors: [{ filePath: agentsDir, message: 'Agents directory not found' }],
    };
  }

  const parsePromises = files.map(async (file) => {
    const filePath = join(agentsDir, file);
    try {
      const raw = await withRetry(() => readFile(filePath, 'utf-8'));
      const { data, content } = parseFrontmatter(raw);
      const name = data.name ?? basename(file, '.md');
      const description = typeof data.description === 'string' ? data.description.trim() : '';
      const source = inferSource(name, filePath);
      const tags = extractTags(name, description, data);
      const lastModified = await getLastModified(filePath);

      const entry: VaultEntry = {
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
      entries.push(entry);
    } catch (err) {
      errors.push({
        filePath,
        message: `Failed to parse agent: ${(err as Error).message}`,
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
