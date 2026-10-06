import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sep } from 'node:path';

/**
 * `safePath` on Windows path semantics, run on any machine.
 *
 * `node:path` is replaced by `path.win32`, and `realpath` by a small table that behaves the way
 * Windows does for the cases that matter here: it answers with the canonical spelling (long names,
 * stored case), it is case-insensitive, and it rejects a file that is not in the table. So this
 * proves the containment DECISION under Windows rules. Whether the real `fs.promises.realpath`
 * answers that way on a Windows runner (8.3 names such as RUNNER~1, drive letter case) can only
 * be confirmed by the `Test (windows-latest)` job.
 *
 * Before the fix `safePath` compared strings with a '/' separator, so under these rules no file
 * nested in a root was ever inside it: every hook script fell back to its command string.
 */

const fakeFs = vi.hoisted(() => ({
  /** Lower-cased lookup key to the canonical spelling of each file or directory that "exists". */
  existing: new Map<string, string>(),
  /** Lower-cased short-name prefix to the long-name prefix it expands to. */
  shortNames: new Map<string, string>(),
}));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual.win32, win32: actual.win32, posix: actual.posix, default: actual.win32 };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { win32: windowsPath } = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    realpath: async (path: string): Promise<string> => {
      let key = windowsPath.resolve(path).toLowerCase();
      for (const [short, long] of fakeFs.shortNames) {
        if (key === short || key.startsWith(`${short}\\`)) key = long + key.slice(short.length);
      }
      const canonical = fakeFs.existing.get(key);
      if (canonical === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
          code: 'ENOENT',
        });
      }
      return canonical;
    },
  };
});

import { safePath } from '../parsers/utils.js';

function exists(...canonicalPaths: readonly string[]): void {
  for (const canonical of canonicalPaths) fakeFs.existing.set(canonical.toLowerCase(), canonical);
}

beforeEach(() => {
  fakeFs.existing.clear();
  fakeFs.shortNames.clear();
});

describe('safePath under Windows path rules', () => {
  it('returns a script nested in the root (it returned null for every script before)', async () => {
    exists('C:\\root', 'C:\\root\\hooks', 'C:\\root\\hooks\\x.js');

    expect(await safePath('C:\\root\\hooks\\x.js', ['C:\\root'])).toBe('C:\\root\\hooks\\x.js');
  });

  it('returns a script a direct child of the root', async () => {
    exists('C:\\root', 'C:\\root\\x.js');

    expect(await safePath('C:\\root\\x.js', ['C:\\root'])).toBe('C:\\root\\x.js');
  });

  it('returns the canonical spelling for a candidate written with slashes', async () => {
    exists('C:\\root', 'C:\\root\\hooks\\x.js');

    expect(await safePath('C:/root/hooks/x.js', ['C:\\root'])).toBe('C:\\root\\hooks\\x.js');
  });

  it('accepts the root itself and a root with a trailing separator', async () => {
    exists('C:\\root', 'C:\\root\\x.js');

    expect(await safePath('C:\\root', ['C:\\root'])).toBe('C:\\root');
    expect(await safePath('C:\\root\\x.js', ['C:\\root\\'])).toBe('C:\\root\\x.js');
  });

  it('accepts a root spelled with a lowercase drive letter', async () => {
    exists('C:\\root', 'C:\\root\\x.js');

    expect(await safePath('C:\\root\\x.js', ['c:\\root'])).toBe('C:\\root\\x.js');
  });

  it('accepts a root spelled with a short (8.3) name once it is expanded', async () => {
    // GetFinalPathNameByHandle answers with long names, so the file comes back as runneradmin
    // while the root the caller holds still says RUNNER~1.
    exists('C:\\Users\\runneradmin\\Temp\\cv', 'C:\\Users\\runneradmin\\Temp\\cv\\x.js');
    fakeFs.shortNames.set('c:\\users\\runner~1', 'c:\\users\\runneradmin');

    const safe = await safePath('C:\\Users\\RUNNER~1\\Temp\\cv\\x.js', [
      'C:\\Users\\RUNNER~1\\Temp\\cv',
    ]);

    expect(safe).toBe('C:\\Users\\runneradmin\\Temp\\cv\\x.js');
  });

  it('refuses a sibling directory that shares the root as a prefix', async () => {
    exists('C:\\root', 'C:\\root-evil', 'C:\\root-evil\\x.js');

    expect(await safePath('C:\\root-evil\\x.js', ['C:\\root'])).toBeNull();
  });

  it('refuses a path that climbs out of the root with ..', async () => {
    exists('C:\\root', 'C:\\other', 'C:\\other\\x.js');

    expect(await safePath('C:\\root\\..\\other\\x.js', ['C:\\root'])).toBeNull();
  });

  it('refuses the same path on another drive', async () => {
    exists('C:\\root', 'D:\\root', 'D:\\root\\x.js');

    expect(await safePath('D:\\root\\x.js', ['C:\\root'])).toBeNull();
    expect(await safePath('d:\\root\\x.js', ['C:\\root'])).toBeNull();
  });

  it('accepts a file literally named ..foo', async () => {
    exists('C:\\root', 'C:\\root\\..foo');

    expect(await safePath('C:\\root\\..foo', ['C:\\root'])).toBe('C:\\root\\..foo');
  });

  it('accepts a UNC path under a UNC root and refuses another share', async () => {
    exists('\\\\srv\\share\\dir', '\\\\srv\\share\\dir\\x.js', '\\\\srv\\share2\\x.js');

    expect(await safePath('\\\\srv\\share\\dir\\x.js', ['\\\\srv\\share\\dir'])).toBe(
      '\\\\srv\\share\\dir\\x.js',
    );
    expect(await safePath('\\\\srv\\share2\\x.js', ['\\\\srv\\share'])).toBeNull();
  });

  it('still uses the other roots when one of them does not exist', async () => {
    exists('C:\\settings', 'C:\\settings\\x.js');

    expect(await safePath('C:\\settings\\x.js', ['C:\\no-such-project', 'C:\\settings'])).toBe(
      'C:\\settings\\x.js',
    );
  });

  it('returns null for a file that does not exist', async () => {
    exists('C:\\root');

    expect(await safePath('C:\\root\\missing.js', ['C:\\root'])).toBeNull();
  });

  it('runs on the Windows path module, or every case above would prove nothing', () => {
    expect(sep).toBe('\\');
  });
});
