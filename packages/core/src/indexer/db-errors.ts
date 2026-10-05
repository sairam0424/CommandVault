/** What an open failure means, judged only from the evidence it carries; `unknown` touches nothing. */
export type OpenErrorKind = 'native-addon' | 'locked' | 'permission' | 'corrupt' | 'io' | 'unknown';

const CODE_RULES: ReadonlyArray<readonly [RegExp, OpenErrorKind]> = [
  [/^SQLITE_(NOTADB|CORRUPT)(_|$)/, 'corrupt'],
  [/^SQLITE_(BUSY|LOCKED)(_|$)/, 'locked'],
  // Another process repairing a corrupt vault.db deleted a journal or WAL under this connection.
  // Opening again sees the settled state, so treat it like a lock. Must precede the I/O rule.
  [/^SQLITE_IOERR_DELETE_NOENT$/, 'locked'],
  [/^SQLITE_(CANTOPEN|READONLY|PERM)(_|$)/, 'permission'],
  [/^SQLITE_(IOERR|FULL)(_|$)/, 'io'],
  [/^ERR_DLOPEN_FAILED$/, 'native-addon'],
  [/^(EACCES|EPERM|EROFS)$/, 'permission'],
  [/^EBUSY$/, 'locked'],
  [/^(ENOSPC|EMFILE|EIO)$/, 'io'],
];

// The native addon loader throws without a stable code in some paths, and sql.js never sets one.
const MESSAGE_RULES: ReadonlyArray<readonly [RegExp, OpenErrorKind]> = [
  [
    /NODE_MODULE_VERSION|compiled against a different Node\.js version|Could not locate the bindings file/,
    'native-addon',
  ],
  [/^(file is not a database|database disk image is malformed)$/, 'corrupt'],
  // Only the form without a " - <detail>" tail is proof: with a detail it can also mean a schema
  // this engine is too old to parse (`near "STRICT": syntax error`) in a healthy database.
  [/^malformed database schema \([^)]*\)$/, 'corrupt'],
];

// better-sqlite3 gives that detail form the code SQLITE_CORRUPT, so the rules above never see it.
const UNPROVEN_SCHEMA_ERROR = /^malformed database schema \([^)]*\) - /;

const ABI_PATTERN = /NODE_MODULE_VERSION\s+(\d+)[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/;

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyOpenError(error: unknown): OpenErrorKind {
  const message = errorMessage(error);
  const code = errorCode(error);
  if (code !== undefined) {
    const byCode = CODE_RULES.find(([pattern]) => pattern.test(code));
    if (byCode !== undefined) return withholdUnprovenCorruption(byCode[1], message);
  }
  return MESSAGE_RULES.find(([pattern]) => pattern.test(message))?.[1] ?? 'unknown';
}

/** A schema SQLite could not parse is only corruption without a detail; see MESSAGE_RULES. */
function withholdUnprovenCorruption(kind: OpenErrorKind, message: string): OpenErrorKind {
  return kind === 'corrupt' && UNPROVEN_SCHEMA_ERROR.test(message) ? 'unknown' : kind;
}

/**
 * Base class so callers can catch every database-open failure with one `instanceof`. Each class
 * spells its own `name`: `new.target.name` is a mangled identifier in the minified VS Code bundle.
 */
export class DatabaseOpenError extends Error {
  override readonly name: string = 'DatabaseOpenError';
  readonly dbPath: string;

  constructor(message: string, dbPath: string, cause?: unknown) {
    super(message, { cause });
    this.dbPath = dbPath;
  }
}

export class NativeAddonUnavailableError extends DatabaseOpenError {
  override readonly name = 'NativeAddonUnavailableError';

  constructor(dbPath: string, cause?: unknown) {
    super(nativeAddonMessage(dbPath, cause), dbPath, cause);
  }
}

export class DatabaseLockedError extends DatabaseOpenError {
  override readonly name = 'DatabaseLockedError';

  constructor(dbPath: string, cause?: unknown) {
    const detail = cause === undefined ? '' : ` (${describeCause(cause)})`;
    super(
      `Cannot open ${dbPath}: the database is locked by another process and stayed locked ` +
        `after several retries${detail}. Database not modified. Close other CommandVault ` +
        'processes (CLI, TUI, VS Code) that are using it, then try again.',
      dbPath,
      cause,
    );
  }
}

export class DatabasePermissionError extends DatabaseOpenError {
  override readonly name = 'DatabasePermissionError';

  constructor(dbPath: string, cause?: unknown) {
    super(
      `Cannot open ${dbPath}: ${describeCause(cause)}. Database not modified. ` +
        'Check that the file and its folder are owned by you and writable ' +
        `(for example: chmod u+rw "${dbPath}") and that the location is not read-only.`,
      dbPath,
      cause,
    );
  }
}

/** Positive corruption evidence, but the file was left where it is (read-only open, or a race). */
export class DatabaseCorruptError extends DatabaseOpenError {
  override readonly name = 'DatabaseCorruptError';

  constructor(dbPath: string, cause?: unknown) {
    super(
      `${dbPath} is not a valid SQLite database (${describeCause(cause)}). ` +
        'Database not modified. Move it aside yourself, or restore it from a backup, ' +
        'then run CommandVault again to create a new one.',
      dbPath,
      cause,
    );
  }
}

export class DatabaseIoError extends DatabaseOpenError {
  override readonly name = 'DatabaseIoError';

  constructor(dbPath: string, cause?: unknown) {
    super(
      `I/O error while opening ${dbPath}: ${describeCause(cause)}. ` +
        'No data was deleted. ' +
        'Check free disk space and the open-file limit (ulimit -n), then try again.',
      dbPath,
      cause,
    );
  }
}

export function describeCause(cause: unknown): string {
  const code = errorCode(cause);
  const message = errorMessage(cause);
  return code === undefined ? message : `${code}: ${message}`;
}

function parseAbiVersions(cause: unknown): { built: string; running: string } | undefined {
  const match = ABI_PATTERN.exec(errorMessage(cause));
  return match === null ? undefined : { built: match[1]!, running: match[2]! };
}

/** The loader's own words, first line only: a wrong CPU type or a missing library has no ABI. */
function loaderReason(cause: unknown): string {
  if (cause === undefined) return '';
  const [firstLine = ''] = describeCause(cause).split('\n');
  return ` (${firstLine})`;
}

function nativeAddonMessage(dbPath: string, cause: unknown): string {
  const abi = parseAbiVersions(cause);
  const running = abi?.running ?? process.versions.modules;
  const detail =
    abi === undefined
      ? `The addon is missing or was built for a different Node.js version${loaderReason(cause)}`
      : `The addon was built for Node ABI ${abi.built}`;
  return (
    `Cannot load the native SQLite addon (better-sqlite3), so ${dbPath} was not opened. ` +
    `${detail}; this process runs Node ${process.version} (ABI ${running}). ` +
    'Database not modified. Fix: run `npm rebuild better-sqlite3` with the same Node you use ' +
    'to run CommandVault (pnpm 10: `pnpm approve-builds`, then reinstall), ' +
    'or switch back to the Node version that installed it.'
  );
}

const ERROR_CLASS_BY_KIND = {
  'native-addon': NativeAddonUnavailableError,
  locked: DatabaseLockedError,
  permission: DatabasePermissionError,
  corrupt: DatabaseCorruptError,
  io: DatabaseIoError,
} as const;

/** The typed error for a raw open failure; unknown failures come back untouched, stack included. */
export function toOpenError(error: unknown, dbPath: string): unknown {
  if (error instanceof DatabaseOpenError) return error;
  const kind = classifyOpenError(error);
  return kind === 'unknown' ? error : new ERROR_CLASS_BY_KIND[kind](dbPath, error);
}
