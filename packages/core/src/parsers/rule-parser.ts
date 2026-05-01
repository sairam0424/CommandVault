import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateStableId, parseFrontmatter, getLastModified, extractTags } from './utils.js';

export async function parseRules(rulesDir: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let files: string[];
  try {
    files = (await readdir(rulesDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return { entries: [], errors: [{ filePath: rulesDir, message: 'Rules directory not found' }] };
  }

  const parsePromises = files.map(async (file) => {
    const filePath = join(rulesDir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      const name = data.name ?? basename(file, '.md').replace(/-/g, ' ');
      const firstLine = content.split('\n').find((l) => l.startsWith('# '));
      const description =
        typeof data.description === 'string'
          ? data.description.trim()
          : (firstLine?.replace(/^#\s+/, '') ?? `Rule: ${name}`);
      const tags = extractTags(name, description, data);
      tags.push('rule');
      const lastModified = await getLastModified(filePath);

      const entry: VaultEntry = {
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
      entries.push(entry);
    } catch (err) {
      errors.push({
        filePath,
        message: `Failed to parse rule: ${(err as Error).message}`,
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
