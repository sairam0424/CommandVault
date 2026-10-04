import { isAbsolute, join, relative, sep } from 'node:path';
import type { Stats } from 'node:fs';

// chokidar 4 removed glob support, so VaultWatcher watches whole directories
// and uses this predicate to drop everything that is not a vault source file.

/** Sections whose markdown sits directly inside the section directory. */
const FLAT_MARKDOWN_SECTIONS = new Set(['agents', 'rules']);
const NESTED_MARKDOWN_SECTION = 'commands';
const SKILLS_SECTION = 'skills';

const SKILL_FILE_NAME = 'SKILL.md';
const MARKDOWN_EXTENSION = '.md';
const SETTINGS_FILE = 'settings.json';
const INSTALLED_PLUGINS_SEGMENTS = ['plugins', 'installed_plugins.json'];

/** Depth of `<section>/<file>` relative to the Claude config directory. */
const FLAT_FILE_DEPTH = 2;

/** Directory watch roots handed to chokidar; missing ones are skipped by chokidar. */
export function watchedDirectories(claudePath: string): string[] {
  return [SKILLS_SECTION, NESTED_MARKDOWN_SECTION, ...FLAT_MARKDOWN_SECTIONS].map((section) =>
    join(claudePath, section),
  );
}

/** Literal files handed to chokidar. Watching `plugins/` would walk the whole plugin cache. */
export function watchedFiles(claudePath: string): string[] {
  return [join(claudePath, SETTINGS_FILE), join(claudePath, ...INSTALLED_PLUGINS_SEGMENTS)];
}

function isNoiseSegment(segment: string): boolean {
  // Dot entries cover editor swap/lock files (.z.md.swp, .#z.md) and .git
  // folders; node_modules inside a skill folder can hold thousands of files
  // that would otherwise all be watched.
  return segment.startsWith('.') || segment === 'node_modules';
}

function isWatchedFile(segments: string[]): boolean {
  const [section] = segments;
  const name = segments[segments.length - 1] ?? '';

  if (segments.length === 1) return name === SETTINGS_FILE;
  if (segments.join('/') === INSTALLED_PLUGINS_SEGMENTS.join('/')) return true;
  if (section === SKILLS_SECTION) return name === SKILL_FILE_NAME;
  if (section === NESTED_MARKDOWN_SECTION) return name.endsWith(MARKDOWN_EXTENSION);
  if (section !== undefined && FLAT_MARKDOWN_SECTIONS.has(section)) {
    return segments.length === FLAT_FILE_DEPTH && name.endsWith(MARKDOWN_EXTENSION);
  }
  return false;
}

function isWatchedDirectory(segments: string[]): boolean {
  const [section] = segments;
  if (section === SKILLS_SECTION || section === NESTED_MARKDOWN_SECTION) return true;
  // agents/ and rules/ are flat: only the section directory itself is walked.
  return segments.length === 1 && section !== undefined && FLAT_MARKDOWN_SECTIONS.has(section);
}

/**
 * Builds chokidar's `ignored` callback. Returns true for paths that must not be
 * watched. A path without stats (chokidar asks before it has stat'd) is kept so
 * that directories are never pruned by mistake; chokidar asks again with stats
 * for files it is about to report.
 */
export function createSourceIgnore(claudePath: string): (path: string, stats?: Stats) => boolean {
  return (path, stats) => {
    const rel = relative(claudePath, path);
    if (rel === '') return false;
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;

    const segments = rel.split(sep);
    if (segments.some(isNoiseSegment)) return true;
    // chokidar first asks with lstat stats of a symlink, then resolves it and
    // asks again with the target's stats. Deciding on the link itself would
    // prune symlinked skill folders, so defer to the second question.
    if (stats === undefined || stats.isSymbolicLink()) return false;
    return stats.isDirectory() ? !isWatchedDirectory(segments) : !isWatchedFile(segments);
  };
}
