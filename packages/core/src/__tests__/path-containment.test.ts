import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, sep, win32 } from 'node:path';
import { isInsideRoot, safePath } from '../parsers/utils.js';

/**
 * `safePath` decides whether a hook script may be read. The decision is `isInsideRoot`, a pure
 * function over a path module, so both platforms are tested on any machine with `path.posix` and
 * `path.win32`. The real-file-system cases below it run on the platform the suite runs on.
 */

interface ContainmentCase {
  readonly name: string;
  readonly root: string;
  readonly candidate: string;
  readonly isInside: boolean;
}

const POSIX_CASES: readonly ContainmentCase[] = [
  { name: 'a nested file', root: '/a/b', candidate: '/a/b/c/d.js', isInside: true },
  { name: 'a direct child', root: '/a/b', candidate: '/a/b/d.js', isInside: true },
  { name: 'the root itself', root: '/a/b', candidate: '/a/b', isInside: true },
  {
    name: 'a root with a trailing separator',
    root: '/a/b/',
    candidate: '/a/b/d.js',
    isInside: true,
  },
  {
    name: 'a candidate with a trailing separator',
    root: '/a/b',
    candidate: '/a/b/',
    isInside: true,
  },
  {
    name: 'repeated separators and dots',
    root: '/a/b',
    candidate: '/a/b/./c//d.js',
    isInside: true,
  },
  { name: 'a .. that stays inside', root: '/a/b', candidate: '/a/b/x/../y.js', isInside: true },
  { name: 'a file literally named ..foo', root: '/a/b', candidate: '/a/b/..foo', isInside: true },
  {
    name: 'a directory literally named ..foo',
    root: '/a/b',
    candidate: '/a/b/..foo/x.js',
    isInside: true,
  },
  { name: 'a file literally named ...', root: '/a/b', candidate: '/a/b/...', isInside: true },
  { name: 'anything below the file system root', root: '/', candidate: '/x/y.js', isInside: true },
  {
    name: 'a sibling that shares the root as a prefix',
    root: '/a/b',
    candidate: '/a/b-evil/d.js',
    isInside: false,
  },
  { name: 'that sibling directory itself', root: '/a/b', candidate: '/a/b-evil', isInside: false },
  {
    name: 'a sibling that extends the last segment',
    root: '/a/b',
    candidate: '/a/bb',
    isInside: false,
  },
  { name: 'the parent of the root', root: '/a/b', candidate: '/a', isInside: false },
  // posix names are case-sensitive: /a/B is another directory than /a/b (the win32 table has the
  // opposite case, where a different-case directory must be inside)
  {
    name: 'a different-case directory in the path',
    root: '/a/b',
    candidate: '/a/B/x.js',
    isInside: false,
  },
  {
    name: 'a different-case directory in the root',
    root: '/A/b',
    candidate: '/a/b/x.js',
    isInside: false,
  },
  { name: 'a .. that leaves the root', root: '/a/b', candidate: '/a/b/../c.js', isInside: false },
  {
    name: 'a .. that leaves and comes back by another name',
    root: '/a/b',
    candidate: '/a/b/../c/d.js',
    isInside: false,
  },
  { name: 'an unrelated path', root: '/a/b', candidate: '/c/d.js', isInside: false },
];

const WIN32_CASES: readonly ContainmentCase[] = [
  { name: 'a nested file', root: 'C:\\root', candidate: 'C:\\root\\hooks\\x.js', isInside: true },
  {
    name: 'a candidate spelled with slashes',
    root: 'C:\\root',
    candidate: 'C:/root/hooks/x.js',
    isInside: true,
  },
  { name: 'the root itself', root: 'C:\\root', candidate: 'C:\\root', isInside: true },
  {
    name: 'a root with a trailing separator',
    root: 'C:\\root\\',
    candidate: 'C:\\root\\x.js',
    isInside: true,
  },
  {
    name: 'a lowercase drive letter',
    root: 'C:\\root',
    candidate: 'c:\\root\\x.js',
    isInside: true,
  },
  {
    name: 'a lowercase drive letter on the root',
    root: 'c:\\root',
    candidate: 'C:\\root\\x.js',
    isInside: true,
  },
  {
    name: 'different case in a directory name',
    root: 'C:\\Root',
    candidate: 'C:\\ROOT\\x.js',
    isInside: true,
  },
  {
    name: 'a file literally named ..foo',
    root: 'C:\\root',
    candidate: 'C:\\root\\..foo',
    isInside: true,
  },
  {
    name: 'a .. that stays inside',
    root: 'C:\\root',
    candidate: 'C:\\root\\a\\..\\x.js',
    isInside: true,
  },
  { name: 'a drive root', root: 'C:\\', candidate: 'C:\\x.js', isInside: true },
  {
    name: 'a UNC share directory',
    root: '\\\\srv\\share\\dir',
    candidate: '\\\\srv\\share\\dir\\x.js',
    isInside: true,
  },
  {
    name: 'a sibling that shares the root as a prefix',
    root: 'C:\\root',
    candidate: 'C:\\root-evil\\x.js',
    isInside: false,
  },
  { name: 'the parent of the root', root: 'C:\\root\\sub', candidate: 'C:\\root', isInside: false },
  {
    name: 'a .. that leaves the root',
    root: 'C:\\root',
    candidate: 'C:\\root\\..\\other\\x.js',
    isInside: false,
  },
  {
    name: 'the same path on another drive',
    root: 'C:\\root',
    candidate: 'D:\\root\\x.js',
    isInside: false,
  },
  {
    name: 'another drive with a lowercase letter',
    root: 'C:\\root',
    candidate: 'd:\\x.js',
    isInside: false,
  },
  {
    name: 'another drive under a drive root',
    root: 'C:\\',
    candidate: 'D:\\x.js',
    isInside: false,
  },
  {
    name: 'a different UNC share',
    root: '\\\\srv\\share',
    candidate: '\\\\srv\\share2\\x.js',
    isInside: false,
  },
  {
    name: 'a different UNC server',
    root: '\\\\srv1\\share',
    candidate: '\\\\srv2\\share\\x.js',
    isInside: false,
  },
  {
    name: 'a drive path under a UNC root',
    root: '\\\\srv\\share\\dir',
    candidate: 'C:\\x.js',
    isInside: false,
  },
];

describe('isInsideRoot on posix paths', () => {
  it.each(POSIX_CASES)('$name: inside is $isInside', ({ root, candidate, isInside }) => {
    expect(isInsideRoot(root, candidate, posix)).toBe(isInside);
  });
});

describe('isInsideRoot on win32 paths', () => {
  it.each(WIN32_CASES)('$name: inside is $isInside', ({ root, candidate, isInside }) => {
    expect(isInsideRoot(root, candidate, win32)).toBe(isInside);
  });
});

describe('isInsideRoot on the platform the suite runs on', () => {
  it('uses the host path module when none is given', () => {
    const root = join(tmpdir(), 'cv-host-root');

    expect(isInsideRoot(root, join(root, 'x.js'))).toBe(true);
    expect(isInsideRoot(root, `${root}-evil${sep}x.js`)).toBe(false);
  });
});

let root: string;

beforeEach(async () => {
  // Not resolved on purpose: on macOS tmpdir() is reached through /var, a link to /private/var,
  // which is the spelling a caller is likely to hand over as a root.
  root = await mkdtemp(join(tmpdir(), 'cv-safe-path-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A path with its `..` segments still in it. `join` would collapse them, and safePath would never
 * see one. Built on a real path, so the spelling of the root cannot be what decides the outcome.
 */
function spelledWithDotDot(...segments: readonly string[]): string {
  const spelled = segments.join(sep);
  expect(spelled.split(sep)).toContain('..');
  return spelled;
}

async function touch(relativePath: string): Promise<string> {
  const filePath = join(root, ...relativePath.split('/'));
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, 'x');
  return filePath;
}

describe('safePath on the real file system', () => {
  it('returns the real path of a file inside the root, however the root is spelled', async () => {
    const script = await touch('allowed/hooks/x.js');

    const safe = await safePath(script, [join(root, 'allowed')]);

    expect(safe).toBe(await realpath(script));
  });

  it('accepts the root itself and a root with a trailing separator', async () => {
    const dir = join(root, 'allowed');
    await touch('allowed/x.js');

    expect(await safePath(dir, [dir])).toBe(await realpath(dir));
    expect(await safePath(join(dir, 'x.js'), [dir + sep])).toBe(await realpath(join(dir, 'x.js')));
  });

  it('accepts a file literally named ..foo', async () => {
    const script = await touch('allowed/..foo');

    expect(await safePath(script, [join(root, 'allowed')])).toBe(await realpath(script));
  });

  it('refuses a sibling directory that shares the root as a prefix', async () => {
    await touch('allowed/x.js');
    const evil = await touch('allowed-evil/x.js');

    expect(await safePath(evil, [join(root, 'allowed')])).toBeNull();
  });

  it('refuses a path that climbs out of the root with ..', async () => {
    await touch('allowed/x.js');
    const outside = await touch('outside/x.js');
    const base = await realpath(root);
    const climbing = spelledWithDotDot(base, 'allowed', '..', 'outside', 'x.js');

    expect(await safePath(climbing, [join(base, 'allowed')])).toBeNull();
    expect(await safePath(outside, [join(base, 'allowed')])).toBeNull();
  });

  it('accepts a path that goes down, up and down again inside the root', async () => {
    const script = await touch('allowed/sub/x.js');
    await mkdir(join(root, 'allowed', 'other'), { recursive: true });
    const base = await realpath(root);
    const detour = spelledWithDotDot(base, 'allowed', 'other', '..', 'sub', 'x.js');

    expect(await safePath(detour, [join(base, 'allowed')])).toBe(await realpath(script));
  });

  it('returns null for a file that does not exist', async () => {
    await mkdir(join(root, 'allowed'), { recursive: true });

    expect(await safePath(join(root, 'allowed', 'missing.js'), [join(root, 'allowed')])).toBeNull();
  });

  it('returns null when there are no roots', async () => {
    const script = await touch('allowed/x.js');

    expect(await safePath(script, [])).toBeNull();
  });

  it('checks every root, in any position', async () => {
    const script = await touch('second/x.js');

    const safe = await safePath(script, [join(root, 'first'), join(root, 'second')]);

    expect(safe).toBe(await realpath(script));
  });

  it('still uses the other roots when one of them does not exist', async () => {
    // A project directory that was deleted or mistyped must not disable the settings directory.
    const script = await touch('settings/x.js');
    const missing = join(root, 'no-such-project');

    expect(await safePath(script, [missing, join(root, 'settings')])).toBe(await realpath(script));
    expect(await safePath(script, [missing])).toBeNull();
  });
});

// Windows cannot create a symlink without SeCreateSymbolicLinkPrivilege (an elevated shell or
// Developer Mode), which a developer machine often lacks, so the link cases run on posix only.
// Their Windows counterpart is the directory-name and drive cases above.
describe.skipIf(process.platform === 'win32')('safePath and symlinks', () => {
  it('refuses a link inside the root that points outside it', async () => {
    const outside = await touch('outside/secret.js');
    await mkdir(join(root, 'allowed'), { recursive: true });
    await symlink(outside, join(root, 'allowed', 'link.js'));

    expect(await safePath(join(root, 'allowed', 'link.js'), [join(root, 'allowed')])).toBeNull();
  });

  it('refuses a file reached through a directory link that points outside the root', async () => {
    await touch('outside/secret.js');
    await mkdir(join(root, 'allowed'), { recursive: true });
    await symlink(join(root, 'outside'), join(root, 'allowed', 'dir-link'));

    const viaLink = join(root, 'allowed', 'dir-link', 'secret.js');

    expect(await safePath(viaLink, [join(root, 'allowed')])).toBeNull();
  });

  it('returns the target, not the link, for a link that stays inside the root', async () => {
    const target = await touch('allowed/real.js');
    await symlink(target, join(root, 'allowed', 'link.js'));

    const safe = await safePath(join(root, 'allowed', 'link.js'), [join(root, 'allowed')]);

    expect(safe).toBe(await realpath(target));
  });

  it('accepts a root that is itself a link to the directory holding the file', async () => {
    const script = await touch('real/x.js');
    await symlink(join(root, 'real'), join(root, 'real-link'));

    expect(await safePath(script, [join(root, 'real-link')])).toBe(await realpath(script));
  });

  it('accepts a file reached through a link when the root is the real directory', async () => {
    await touch('real/x.js');
    await symlink(join(root, 'real'), join(root, 'real-link'));

    const viaLink = join(root, 'real-link', 'x.js');

    expect(await safePath(viaLink, [join(root, 'real')])).toBe(
      await realpath(join(root, 'real', 'x.js')),
    );
  });
});
