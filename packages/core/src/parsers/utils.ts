import { createHash } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { EntrySource, ParsedFrontmatter } from '../types/index.js';
import {
  parseStrict,
  recoverFrontmatter,
  type FrontmatterRecovery,
  type ParsedFrontmatterResult,
} from './frontmatter-recovery.js';

export type { FrontmatterRecovery, ParsedFrontmatterResult };

export function generateId(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 12);
}

export function generateStableId(type: string, name: string, disambiguator = ''): string {
  const key = disambiguator ? `${type}:${name}:${disambiguator}` : `${type}:${name}`;
  return generateId(key);
}

export function parseFrontmatter(raw: string): ParsedFrontmatterResult {
  try {
    return parseStrict(raw);
  } catch (strictError) {
    const recovered = recoverFrontmatter(raw);
    if (!recovered) throw strictError;
    return { ...recovered, recoveryCause: strictError };
  }
}

export async function getLastModified(filePath: string): Promise<Date> {
  const stats = await stat(filePath);
  return stats.mtime;
}

export function inferSource(name: string, filePath: string): EntrySource {
  const lowerName = name.toLowerCase();
  const lowerPath = filePath.toLowerCase().replace(/\\/g, '/');

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

/** The parts of `node:path` that decide containment, so a test can hand it `win32` on any OS. */
export type ContainmentPath = Pick<path.PlatformPath, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * True when `candidate` is `root` or lies below it. The judgment is the relative path from the
 * root: a sibling that merely starts with the root's name (`/a/b-evil` for `/a/b`) climbs out with
 * `..`, and so does a `..` segment. On Windows `relative` answers with an absolute path for a file
 * on another drive or share, which is not below anything. A first segment that only begins with
 * `..` (a file called `..foo`) is an ordinary name. Purely lexical: resolve symlinks and short
 * names on both sides first, and pass absolute paths, since `relative` resolves against the
 * current directory otherwise.
 */
export function isInsideRoot(
  root: string,
  candidate: string,
  pathModule: ContainmentPath = path,
): boolean {
  const relativePath = pathModule.relative(root, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${pathModule.sep}`)) return false;
  return !pathModule.isAbsolute(relativePath);
}

/**
 * A root as the file system spells it, so it can be compared with a real path: through a symlink
 * (macOS /var is /private/var) and, on Windows, with short names (RUNNER~1) expanded. A root that
 * cannot be resolved, such as a project directory that was deleted, stays as given: it cannot hold
 * a file that exists, and it must not stop the other roots from being used.
 */
async function canonicalRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Validates that a file path resolves within one of the allowed root directories.
 * Returns the resolved real path if safe, or null if the path escapes containment.
 */
export async function safePath(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  try {
    const resolved = await realpath(filePath);
    const roots = await Promise.all(allowedRoots.map(canonicalRoot));
    return roots.some((root) => isInsideRoot(root, resolved)) ? resolved : null;
  } catch {
    return null; // File doesn't exist or can't be resolved
  }
}

const SECRET_PATTERNS = [
  /\.env($|\.)/,
  /credentials/i,
  /secret/i,
  /\.pem$/,
  /id_rsa/,
  /id_ed25519/,
  /\.key$/,
];

export function isSecretFile(fileName: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(fileName));
}
