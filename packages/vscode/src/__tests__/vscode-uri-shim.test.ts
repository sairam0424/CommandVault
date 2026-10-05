import { describe, expect, it } from 'vitest';
import { Uri } from './helpers/vscode-extras';

/**
 * The provider tests trust the shim's Uri to serialise like the editor's. These rows pin it to the
 * real library: each expected value is what `URI.file(input).toString()` returns in vscode-uri
 * 3.2.0 (the version VS Code 1.138 bundles) on macOS and Linux.
 */
describe('the test Uri shim', () => {
  it.each([
    ['a space in the path', '/home/u/.claude/a b.md', 'file:///home/u/.claude/a%20b.md'],
    ['link and punctuation characters', "/x/[a](b)!*'.md", 'file:///x/%5Ba%5D%28b%29%21%2A%27.md'],
    ['non-ASCII characters', '/x/\u00e9\u4e2d.md', 'file:///x/%C3%A9%E4%B8%AD.md'],
    ['a drive letter, lower-cased', 'C:/Users/dev/x.md', 'file:///c%3A/Users/dev/x.md'],
    ['a drive letter after a slash', '/C:/Users/dev/x.md', 'file:///c%3A/Users/dev/x.md'],
    ['a bare drive', 'Z:', 'file:///z%3A'],
    ['a lower-case segment that ends in a colon', '/a:/x.md', 'file:///a%3A/x.md'],
    ['an authority, lower-cased', '//SRV/Share/a b.md', 'file://srv/Share/a%20b.md'],
    ['an authority without a path', '//srv', 'file://srv/'],
    ['a space in the authority', '//sr v/x.md', 'file://sr%20v/x.md'],
    ['a percent sign in the authority', '//sr%v/x.md', 'file://sr%25v/x.md'],
    ['userinfo and a port', '//Us er:p w@Host:80/x.md', 'file://Us%20er:p%20w@host:80/x.md'],
    ['userinfo without a password', '//user@Host/x.md', 'file://user@host/x.md'],
    ['a colon in the user name, which is encoded', '//u:p:w@h/x.md', 'file://u%3Ap:w@h/x.md'],
    ['brackets in the password, which are kept', '//u:p[1]@h/x.md', 'file://u:p[1]@h/x.md'],
    ['a port that is not encoded', '//Host:8 0/x.md', 'file://host:8 0/x.md'],
    ['brackets and colons in the authority', '//[::1]/x.md', 'file://[::1]/x.md'],
  ])('serialises %s like vscode-uri', (_label, input, expected) => {
    expect(Uri.file(input).toString()).toBe(expected);
  });

  it('refuses a path that starts with two slashes once there is no authority', () => {
    expect(() => Uri.file('////srv/x.md')).toThrow(/\[UriError\]/);
  });

  it('throws a URIError for an unpaired surrogate when it is serialised', () => {
    const uri = Uri.file('/x/\ud83d.md');

    expect(() => uri.toString()).toThrow(URIError);
  });
});
