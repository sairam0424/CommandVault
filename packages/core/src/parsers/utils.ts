import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import matter from 'gray-matter';
import type { EntrySource, ParsedFrontmatter } from '../types/index.js';

export function generateId(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 12);
}

export function generateStableId(type: string, name: string, disambiguator = ''): string {
  const key = disambiguator ? `${type}:${name}:${disambiguator}` : `${type}:${name}`;
  return generateId(key);
}

export function parseFrontmatter(raw: string): {
  data: ParsedFrontmatter;
  content: string;
} {
  const { data, content } = matter(raw);
  return { data: data as ParsedFrontmatter, content: content.trim() };
}

export async function getLastModified(filePath: string): Promise<Date> {
  const stats = await stat(filePath);
  return stats.mtime;
}

export function inferSource(name: string, filePath: string): EntrySource {
  const lowerName = name.toLowerCase();
  const lowerPath = filePath.toLowerCase();

  if (lowerName.startsWith('bmad-') || lowerPath.includes('/bmad-')) return 'bmad';
  if (lowerName.startsWith('mindforge') || lowerPath.includes('/mindforge/')) return 'mindforge';
  if (lowerPath.includes('superpowers')) return 'superpowers';
  if (lowerPath.includes('gstack') || lowerPath.includes('/browse')) return 'gstack';
  if (lowerPath.includes('plugins/cache/claude-plugins-official')) return 'official';
  if (lowerPath.includes('plugins/cache/')) return 'community';

  return 'custom';
}

export function extractTags(
  name: string,
  description: string,
  frontmatter: ParsedFrontmatter,
): string[] {
  const tags = new Set<string>();

  if (frontmatter.keywords) {
    for (const kw of frontmatter.keywords) {
      tags.add(kw.toLowerCase());
    }
  }

  if (frontmatter.triggers) {
    for (const trigger of frontmatter.triggers) {
      const words = trigger.toLowerCase().split(/\s+/);
      for (const w of words) {
        if (w.length > 3) tags.add(w);
      }
    }
  }

  const categoryPrefixes = [
    'engineering-',
    'design-',
    'marketing-',
    'sales-',
    'gaming-',
    'china-',
    'social-',
  ];
  for (const prefix of categoryPrefixes) {
    if (name.toLowerCase().startsWith(prefix)) {
      tags.add(prefix.replace('-', ''));
      break;
    }
  }

  const descLower = description.toLowerCase();
  const domainKeywords = [
    'security',
    'testing',
    'review',
    'debug',
    'deploy',
    'design',
    'planning',
    'architecture',
    'qa',
    'api',
    'database',
    'frontend',
    'backend',
    'devops',
    'documentation',
    'performance',
  ];
  for (const keyword of domainKeywords) {
    if (descLower.includes(keyword)) tags.add(keyword);
  }

  return [...tags];
}
