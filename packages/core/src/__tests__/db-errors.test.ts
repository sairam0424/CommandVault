import { describe, expect, it } from 'vitest';
import {
  DatabaseCorruptError,
  DatabaseIoError,
  DatabaseLockedError,
  DatabaseOpenError,
  DatabasePermissionError,
  NativeAddonUnavailableError,
  classifyOpenError,
  toOpenError,
  type OpenErrorKind,
} from '../indexer/db-errors.js';
import * as core from '../index.js';

function withCode(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyOpenError', () => {
  it.each<[string, OpenErrorKind]>([
    ['SQLITE_NOTADB', 'corrupt'],
    ['SQLITE_CORRUPT', 'corrupt'],
    ['SQLITE_CORRUPT_INDEX', 'corrupt'],
    ['SQLITE_BUSY', 'locked'],
    ['SQLITE_BUSY_SNAPSHOT', 'locked'],
    ['SQLITE_LOCKED', 'locked'],
    ['EBUSY', 'locked'],
    // Another process deleted a journal or WAL file under this connection: retry, not a disk fault.
    ['SQLITE_IOERR_DELETE_NOENT', 'locked'],
    ['SQLITE_CANTOPEN', 'permission'],
    ['SQLITE_READONLY', 'permission'],
    ['SQLITE_READONLY_DIRECTORY', 'permission'],
    ['SQLITE_PERM', 'permission'],
    ['EACCES', 'permission'],
    ['EPERM', 'permission'],
    ['EROFS', 'permission'],
    ['SQLITE_IOERR', 'io'],
    ['SQLITE_IOERR_SHORT_READ', 'io'],
    ['SQLITE_FULL', 'io'],
    ['ENOSPC', 'io'],
    ['EMFILE', 'io'],
    ['EIO', 'io'],
    ['ERR_DLOPEN_FAILED', 'native-addon'],
    ['SQLITE_CONSTRAINT', 'unknown'],
    ['SQLITE_ERROR', 'unknown'],
    ['ENOENT', 'unknown'],
    ['EISDIR', 'unknown'],
  ])('maps the code %s to %s', (code, expected) => {
    expect(classifyOpenError(withCode(code))).toBe(expected);
  });

  it.each<[string, OpenErrorKind]>([
    ['compiled against a different Node.js version using NODE_MODULE_VERSION 1', 'native-addon'],
    ['Could not locate the bindings file. Tried: /a/b.node', 'native-addon'],
    ['file is not a database', 'corrupt'],
    ['database disk image is malformed', 'corrupt'],
    ['malformed database schema (favorites)', 'corrupt'],
    // With a detail it may be a healthy schema this engine is too old to parse: never proof.
    ['malformed database schema (t) - near "STRICT": syntax error', 'unknown'],
    ['malformed database schema (idx) - no such module: fts5', 'unknown'],
    ['while loading: malformed database schema (favorites)', 'unknown'],
    ['weird', 'unknown'],
    ['the parser said: file is not a database, but this is something else', 'unknown'],
  ])('maps the code-less message "%s" to %s', (message, expected) => {
    expect(classifyOpenError(new Error(message))).toBe(expected);
  });

  it('prefers the code over a corruption-looking message', () => {
    expect(classifyOpenError(withCode('EACCES', 'file is not a database'))).toBe('permission');
  });

  it.each<[string, string, OpenErrorKind]>([
    // better-sqlite3 sets the code for both forms; only the one without a detail is proof.
    ['SQLITE_CORRUPT', 'malformed database schema (favorites)', 'corrupt'],
    ['SQLITE_CORRUPT', 'malformed database schema (t) - near "STRICT": syntax error', 'unknown'],
    [
      'SQLITE_CORRUPT',
      'malformed database schema (k2) - unknown table option: FROBNICATE',
      'unknown',
    ],
    ['SQLITE_CORRUPT', 'malformed database schema (idx) - no such module: fts5', 'unknown'],
    ['SQLITE_CORRUPT_VTAB', 'malformed database schema (v) - no such module: rtree', 'unknown'],
    // The detail form only lowers a code that would quarantine; it never raises or hides anything else.
    ['SQLITE_CORRUPT', 'database disk image is malformed', 'corrupt'],
    ['SQLITE_NOTADB', 'file is not a database', 'corrupt'],
    ['SQLITE_BUSY', 'malformed database schema (t) - database is locked', 'locked'],
  ])('with the code %s and the message "%s" says %s', (code, message, expected) => {
    expect(classifyOpenError(withCode(code, message))).toBe(expected);
  });

  it.each([[undefined], [null], ['a string'], [42], [{}], [{ code: 7 }]])(
    'treats %j as unknown',
    (thrown) => {
      expect(classifyOpenError(thrown)).toBe('unknown');
    },
  );
});

describe('typed open errors', () => {
  const dbPath = '/data/vault.db';

  it('are all DatabaseOpenError with their own name, the path and the original cause', () => {
    const cause = withCode('EACCES');
    const errors = [
      new NativeAddonUnavailableError(dbPath, cause),
      new DatabaseLockedError(dbPath, cause),
      new DatabasePermissionError(dbPath, cause),
      new DatabaseCorruptError(dbPath, cause),
      new DatabaseIoError(dbPath, cause),
    ];
    expect(errors.map((error) => error.name)).toEqual([
      'NativeAddonUnavailableError',
      'DatabaseLockedError',
      'DatabasePermissionError',
      'DatabaseCorruptError',
      'DatabaseIoError',
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseOpenError);
      expect(error).toBeInstanceOf(Error);
      expect(error.dbPath).toBe(dbPath);
      expect(error.cause).toBe(cause);
      expect(error.message).toContain(dbPath);
    }
  });

  it.each<[string, new (dbPath: string, cause?: unknown) => DatabaseOpenError]>([
    ['NativeAddonUnavailableError', NativeAddonUnavailableError],
    ['DatabaseLockedError', DatabaseLockedError],
    ['DatabasePermissionError', DatabasePermissionError],
    ['DatabaseCorruptError', DatabaseCorruptError],
    ['DatabaseIoError', DatabaseIoError],
  ])('%s keeps its name when a minifier renames the class', (expectedName, ErrorClass) => {
    // esbuild --minify (the VS Code bundle) renames classes, so `new.target.name` would read "o".
    Object.defineProperty(ErrorClass, 'name', { value: 'o', configurable: true });
    try {
      const error = new ErrorClass(dbPath, new Error('x'));
      expect(error.name).toBe(expectedName);
      expect(String(error)).toMatch(new RegExp(`^${expectedName}: `));
    } finally {
      Object.defineProperty(ErrorClass, 'name', { value: expectedName, configurable: true });
    }
  });

  it('are exported from the package root as the very same classes', () => {
    expect(core.DatabaseOpenError).toBe(DatabaseOpenError);
    expect(core.NativeAddonUnavailableError).toBe(NativeAddonUnavailableError);
    expect(core.DatabaseLockedError).toBe(DatabaseLockedError);
    expect(core.DatabasePermissionError).toBe(DatabasePermissionError);
    expect(core.DatabaseCorruptError).toBe(DatabaseCorruptError);
    expect(core.DatabaseIoError).toBe(DatabaseIoError);
    expect(new core.NativeAddonUnavailableError(dbPath)).toBeInstanceOf(core.DatabaseOpenError);
  });

  it('say the database was not modified where that is true, and how to fix it', () => {
    const cause = new Error('x');
    expect(new NativeAddonUnavailableError(dbPath, cause).message).toMatch(
      /database not modified/i,
    );
    expect(new DatabaseLockedError(dbPath, cause).message).toMatch(/database not modified/i);
    expect(new DatabasePermissionError(dbPath, cause).message).toMatch(/database not modified/i);
    expect(new DatabaseCorruptError(dbPath, cause).message).toMatch(/database not modified/i);
    expect(new DatabaseIoError(dbPath, cause).message).toMatch(/no data was deleted/i);
    expect(new DatabaseLockedError(dbPath, cause).message).toMatch(/another process/i);
    expect(new DatabasePermissionError(dbPath, cause).message).toContain(`chmod u+rw "${dbPath}"`);
  });

  it('states built-versus-running ABI when the loader message carries both', () => {
    const cause = new Error(
      'using\nNODE_MODULE_VERSION 115. This requires\nNODE_MODULE_VERSION 131.',
    );
    const { message } = new NativeAddonUnavailableError(dbPath, cause);
    expect(message).toContain('built for Node ABI 115');
    expect(message).toContain('(ABI 131)');
    expect(message).toContain('`npm rebuild better-sqlite3`');
    expect(message).toContain('`pnpm approve-builds`');
  });

  it('falls back to the running ABI without inventing a built one', () => {
    const { message } = new NativeAddonUnavailableError(dbPath, new Error('bindings missing'));
    expect(message).toContain(`(ABI ${process.versions.modules})`);
    expect(message).not.toMatch(/built for Node ABI/);
  });

  it.each([
    [
      'a machine architecture mismatch',
      "dlopen(/x/better_sqlite3.node, 0x0001): tried: '/x/better_sqlite3.node' (mach-o file, but is " +
        "an incompatible architecture (have 'x86_64', need 'arm64'))",
      ["have 'x86_64', need 'arm64'"],
    ],
    [
      'a missing system library',
      '/x/better_sqlite3.node: libstdc++.so.6: cannot open shared object file: No such file',
      ['libstdc++.so.6'],
    ],
  ])('shows the loader reason for %s, which carries no ABI numbers', (_what, text, expected) => {
    const cause = Object.assign(new Error(text), { code: 'ERR_DLOPEN_FAILED' });
    const { message } = new NativeAddonUnavailableError(dbPath, cause);
    for (const part of expected) expect(message).toContain(part);
    expect(message).toContain('ERR_DLOPEN_FAILED');
    expect(message).toContain('`npm rebuild better-sqlite3`');
  });

  it('shows only the first line of a long loader reason', () => {
    const cause = new Error('first reason\nsecond line with a long list of /searched/paths');
    const { message } = new NativeAddonUnavailableError(dbPath, cause);
    expect(message).toContain('first reason');
    expect(message).not.toContain('second line');
  });

  it('does not invent a reason when the error was built without a cause', () => {
    expect(new NativeAddonUnavailableError(dbPath).message).not.toContain('undefined');
  });
});

describe('toOpenError', () => {
  it('returns an unknown failure as the very same object', () => {
    const weird = new Error('weird');
    expect(toOpenError(weird, '/x/vault.db')).toBe(weird);
  });

  it('passes an already typed error through unchanged', () => {
    const typed = new DatabaseLockedError('/x/vault.db');
    expect(toOpenError(typed, '/x/vault.db')).toBe(typed);
  });

  it('does not classify a typed error again by the words in its message', () => {
    // The message of this error quotes the loader, so the message rules would match it a second
    // time and wrap it in a copy of itself.
    const typed = new NativeAddonUnavailableError(
      '/x/vault.db',
      new Error('Could not locate the bindings file. Tried: /x/build/Release/better_sqlite3.node'),
    );
    expect(classifyOpenError(typed)).toBe('native-addon');

    expect(toOpenError(typed, '/x/vault.db')).toBe(typed);
  });

  it.each<[string, new (dbPath: string, cause?: unknown) => DatabaseOpenError]>([
    ['ERR_DLOPEN_FAILED', NativeAddonUnavailableError],
    ['SQLITE_BUSY', DatabaseLockedError],
    ['EACCES', DatabasePermissionError],
    ['SQLITE_NOTADB', DatabaseCorruptError],
    ['ENOSPC', DatabaseIoError],
  ])('wraps %s in the matching typed error', (code, expected) => {
    expect(toOpenError(withCode(code), '/x/vault.db')).toBeInstanceOf(expected);
  });
});
