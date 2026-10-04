import { describe, it, expect } from 'vitest';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { createSourceIgnore, watchedDirectories, watchedFiles } from '../watcher/source-filter.js';

const CLAUDE_PATH = join('/home', 'user', '.claude');

type Kind = 'file' | 'dir' | 'symlink';

const statsOf = (kind: Kind): Stats =>
  ({
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
  }) as Stats;

describe('createSourceIgnore', () => {
  const ignored = createSourceIgnore(CLAUDE_PATH);
  const isIgnored = (kind: Kind, ...segments: string[]): boolean =>
    ignored(join(CLAUDE_PATH, ...segments), statsOf(kind));

  it.each([
    [['skills', 'my-skill', 'SKILL.md']],
    [['skills', 'group', 'my-skill', 'SKILL.md']],
    [['agents', 'reviewer.md']],
    [['commands', 'deploy.md']],
    [['commands', 'sub', 'dir', 'deep.md']],
    [['rules', 'style.md']],
    [['settings.json']],
    [['plugins', 'installed_plugins.json']],
  ])('keeps the source file %j', (segments) => {
    expect(isIgnored('file', ...segments)).toBe(false);
  });

  it.each([
    [['README.txt']],
    [['history.jsonl']],
    [['skills', 'my-skill', 'README.md']],
    [['skills', 'my-skill', 'SKILL.md.swp']],
    [['agents', 'notes.txt']],
    [['agents', 'nested', 'deep.md']],
    [['rules', 'nested', 'deep.md']],
    [['commands', 'sub', 'notes.txt']],
    [['rules', '.z.md.swp']],
    [['rules', '.#z.md']],
    [['rules', 'z.md~']],
    [['skills', '.git', 'SKILL.md']],
    [['skills', 'my-skill', 'node_modules', 'pkg', 'SKILL.md']],
    [['plugins', 'cache', 'x.json']],
    [['plugins', 'other.json']],
  ])('ignores the non-source file %j', (segments) => {
    expect(isIgnored('file', ...segments)).toBe(true);
  });

  it.each([
    [['skills']],
    [['skills', 'my-skill']],
    [['commands']],
    [['commands', 'sub', 'dir']],
    [['agents']],
    [['rules']],
  ])('walks the directory %j', (segments) => {
    expect(isIgnored('dir', ...segments)).toBe(false);
  });

  it.each([
    [['agents', 'nested']],
    [['rules', 'nested']],
    [['plugins']],
    [['projects']],
    [['skills', '.git']],
    [['skills', 'my-skill', 'node_modules']],
  ])('prunes the directory %j', (segments) => {
    expect(isIgnored('dir', ...segments)).toBe(true);
  });

  it('defers symlinks so chokidar can ask again with the target stats', () => {
    expect(isIgnored('symlink', 'skills', 'linked')).toBe(false);
    expect(isIgnored('symlink', 'rules', 'linked.md')).toBe(false);
  });

  it('never prunes a path it cannot classify yet', () => {
    expect(ignored(join(CLAUDE_PATH, 'skills', 'anything'), undefined)).toBe(false);
  });

  it('does not interfere with the config directory itself or paths outside it', () => {
    expect(ignored(CLAUDE_PATH, statsOf('dir'))).toBe(false);
    expect(ignored(join('/elsewhere', 'file.txt'), statsOf('file'))).toBe(false);
  });
});

describe('watch roots', () => {
  it('lists the four markdown directories and the two literal files', () => {
    expect(watchedDirectories(CLAUDE_PATH).sort()).toEqual(
      ['skills', 'agents', 'commands', 'rules'].map((d) => join(CLAUDE_PATH, d)).sort(),
    );
    expect(watchedFiles(CLAUDE_PATH)).toEqual([
      join(CLAUDE_PATH, 'settings.json'),
      join(CLAUDE_PATH, 'plugins', 'installed_plugins.json'),
    ]);
  });
});
