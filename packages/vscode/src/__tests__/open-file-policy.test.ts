import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { workspace } from 'vscode';
import { configurationWith } from './helpers/vscode-extras';
import type { SettingScopes } from './helpers/vscode-extras';
import { allowedRoots, isBelow } from '../webview/open-file-policy';

/** A root that is never created: isBelow compares strings and allowedRoots builds them. */
const ROOT = resolve(tmpdir(), 'cv-policy-root');

describe('isBelow', () => {
  it.each([
    ['a child', join(ROOT, 'a.md')],
    ['a deeply nested child', join(ROOT, 'a', 'b', 'c', 'd.md')],
    ['a child whose name starts with two dots', join(ROOT, '..notes.md')],
    ['a child in a directory whose name starts with two dots', join(ROOT, '..hidden', 'x.md')],
  ])('accepts %s', (_label, candidate) => {
    expect(isBelow(ROOT, candidate)).toBe(true);
  });

  it.each([
    ['the root itself', ROOT],
    ['the parent of the root', dirname(ROOT)],
    ['the grandparent of the root', dirname(dirname(ROOT))],
    ['a sibling', join(dirname(ROOT), 'cv-policy-sibling', 'a.md')],
    ['a sibling whose name starts with the root name', join(`${ROOT}-evil`, 'a.md')],
    ['a file that climbs out of the root', `${ROOT}${sep}..${sep}x.md`],
    ['a file that climbs out two levels', `${ROOT}${sep}a${sep}..${sep}..${sep}x.md`],
  ])('refuses %s', (_label, candidate) => {
    expect(isBelow(ROOT, candidate)).toBe(false);
  });

  it('accepts a path that climbs out and back in', () => {
    expect(isBelow(ROOT, `${ROOT}${sep}a${sep}..${sep}b.md`)).toBe(true);
  });
});

/**
 * Windows paths on every OS: path.win32 is the flavour the production code gets on Windows, and the
 * CI job that runs there has no second drive to point a test at.
 */
describe('isBelow with Windows paths', () => {
  const WIN_ROOT = 'C:\\Users\\dev\\.claude';

  it.each([
    ['a child', `${WIN_ROOT}\\skills\\a.md`],
    [
      'a child spelled in another case, since the drive and names are case-insensitive',
      'c:\\USERS\\dev\\.CLAUDE\\a.md',
    ],
    ['a child whose name starts with two dots', `${WIN_ROOT}\\..notes.md`],
  ])('accepts %s', (_label, candidate) => {
    expect(isBelow(WIN_ROOT, candidate, win32)).toBe(true);
  });

  it.each([
    ['the root itself', WIN_ROOT],
    [
      'a file on another drive, which path.relative returns as an absolute path',
      'D:\\secret\\x.md',
    ],
    ['a file on another drive under the same names', 'D:\\Users\\dev\\.claude\\x.md'],
    ['a UNC share', '\\\\server\\share\\x.md'],
    ['a sibling whose name starts with the root name', `${WIN_ROOT}-evil\\a.md`],
    ['a file that climbs out of the root', `${WIN_ROOT}\\..\\x.md`],
  ])('refuses %s', (_label, candidate) => {
    expect(isBelow(WIN_ROOT, candidate, win32)).toBe(false);
  });
});

describe('allowedRoots', () => {
  let savedClaudeDir: string | undefined;

  beforeEach(() => {
    savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    setSetting({});
  });

  afterEach(() => {
    if (savedClaudeDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
    }
  });

  function setSetting(scopes: SettingScopes): void {
    (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(
      configurationWith(scopes),
    );
  }

  it('lists ~/.claude and the other assistants, read when asked', () => {
    expect(allowedRoots()).toEqual([
      join(homedir(), '.claude'),
      join(homedir(), '.cursor'),
      join(homedir(), '.continue'),
    ]);

    process.env.CLAUDE_CONFIG_DIR = ROOT;

    expect(allowedRoots()[0]).toBe(ROOT);
  });

  it('adds the directory the user settings name, trimmed', () => {
    setSetting({ globalValue: `  ${ROOT}  ` });

    expect(allowedRoots()).toContain(ROOT);
  });

  it('builds only absolute roots when HOME and USERPROFILE are empty, as if they were unset', () => {
    // os.homedir() returns '' for an empty HOME, and path.join('', '.cursor') is the RELATIVE
    // '.cursor', which fs.realpath resolves against the editor's working directory.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = '';
    process.env.USERPROFILE = '';
    process.env.CLAUDE_CONFIG_DIR = ROOT;

    try {
      const roots = allowedRoots();

      expect(roots).toHaveLength(3);
      expect(roots.filter((root) => !isAbsolute(root))).toEqual([]);
      expect(roots).not.toContain('.cursor');
      expect(roots).not.toContain('.continue');
    } finally {
      restoreEnv(saved);
    }
  });

  it('asks for the commandvault.claudeConfigPath setting', () => {
    allowedRoots();

    expect(workspace.getConfiguration).toHaveBeenCalledWith('commandvault');
  });

  it.each([
    ['a workspace value', { workspaceValue: ROOT }],
    ['a workspace folder value', { workspaceFolderValue: ROOT }],
    ['a relative value', { globalValue: 'claude' }],
    ['a value that is not text', { globalValue: { path: ROOT } }],
    ['an empty value', { globalValue: '' }],
  ])('leaves out %s', (_label, scopes) => {
    setSetting(scopes);

    expect(allowedRoots()).not.toContain(ROOT);
    expect(allowedRoots()).toHaveLength(3);
  });
});

function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
