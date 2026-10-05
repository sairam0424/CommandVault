import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('vscode', async (importOriginal) =>
  (await import('./helpers/vscode-extras')).withVscodeExtras(await importOriginal<object>()),
);

import * as vscode from 'vscode';
import { sourceFileUri } from '../providers/source-link';

describe('sourceFileUri', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the file: URI of a local absolute path', () => {
    const uri = sourceFileUri('/home/user/.claude/skills/review.md');

    expect(uri?.scheme).toBe('file');
    expect(uri?.path).toBe('/home/user/.claude/skills/review.md');
  });

  it.each([
    ['an imported label', 'imported:/tmp/bundle.json'],
    ['a relative path', 'skills/review.md'],
    ['a UNC path', '//attacker-host/share/review.md'],
    ['an unpaired surrogate (Uri.toString throws a URIError)', '/x/\ud83d.md'],
    ['four leading slashes (Uri.file throws a UriError)', '////srv/review.md'],
  ])('returns nothing for %s', (_label, filePath) => {
    expect(sourceFileUri(filePath)).toBeUndefined();
  });

  it('does not hide an error that is not about the shape of the path', () => {
    vi.spyOn(vscode.Uri, 'file').mockImplementation(() => {
      throw new TypeError('not a URI problem');
    });

    expect(() => sourceFileUri('/home/user/.claude/skills/review.md')).toThrow('not a URI problem');
  });
});
