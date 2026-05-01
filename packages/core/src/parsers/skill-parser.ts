import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import {
  generateStableId,
  parseFrontmatter,
  getLastModified,
  inferSource,
  extractTags,
} from './utils.js';

export async function parseSkills(skillsDir: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let dirs: string[];
  try {
    dirs = await readdir(skillsDir);
  } catch {
    return {
      entries: [],
      errors: [{ filePath: skillsDir, message: 'Skills directory not found' }],
    };
  }

  const parsePromises = dirs.map(async (dir) => {
    const skillFile = join(skillsDir, dir, 'SKILL.md');
    try {
      const raw = await readFile(skillFile, 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      const name = data.name ?? dir;
      const description = typeof data.description === 'string' ? data.description.trim() : '';
      const source = inferSource(name, skillFile);
      const tags = extractTags(name, description, data);
      const lastModified = await getLastModified(skillFile);

      const entry: VaultEntry = {
        id: generateStableId('skill', name, source),
        name,
        type: 'skill',
        source,
        description,
        filePath: skillFile,
        tags,
        metadata: {
          version: data.version,
          preambleTier: data.preambleTier ?? data['preamble-tier'],
          triggers: data.triggers,
          allowedTools: data.allowedTools ?? data['allowed-tools'],
          folderName: dir,
        },
        content,
        lastModified,
        favorite: false,
        usageCount: 0,
      };
      entries.push(entry);
    } catch (err) {
      const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isNotFound) {
        errors.push({
          filePath: skillFile,
          message: `Failed to parse skill: ${(err as Error).message}`,
          cause: err,
        });
      }
    }
  });

  await Promise.all(parsePromises);
  return { entries, errors };
}
