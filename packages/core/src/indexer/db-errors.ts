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

/**
 * What can be promised of the file when a failure is reported, by how far the open got. Most of the
 * time nothing was written (`unmodified`). A file that was still in rollback-journal mode is
 * switched to write-ahead logging before the migrations start: its bytes change, its entries do
 * not (`journal-switched`). Once the migrations have committed the schema may be new as well
 * (`entries-untouched`).
 */
export type FileState = 'unmodified' | 'journal-switched' | 'entries-untouched';

const FILE_STATE_SENTENCE: Readonly<Record<FileState, string>> = {
  unmodified: 'Database not modified.',
  'journal-switched':
    'No entry was changed or deleted. Opening it may have switched the file to write-ahead ' +
    'logging, which changes how it is stored, not what it holds.',
  'entries-untouched':
    'No entry was changed or deleted. If opening it had to bring its schema up to date first, ' +
    'that change was kept, and the copy taken before it is in the "backups" folder next to ' +
    'the database.',
};

export class DatabaseLockedError extends DatabaseOpenError {
  override readonly name = 'DatabaseLockedError';

  constructor(dbPath: string, cause?: unknown, fileState: FileState = 'unmodified') {
    const detail = cause === undefined ? '' : ` (${describeCause(cause)})`;
    super(
      `Cannot open ${dbPath}: the database is locked by another process and was still locked ` +
        `when the wait for it ended${detail}. ${FILE_STATE_SENTENCE[fileState]} Close other ` +
        'CommandVault processes (CLI, TUI, VS Code) that are using it, then try again.',
      dbPath,
      cause,
    );
  }
}

export class DatabasePermissionError extends DatabaseOpenError {
  override readonly name = 'DatabasePermissionError';

  constructor(dbPath: string, cause?: unknown, fileState: FileState = 'unmodified') {
    super(
      `Cannot open ${dbPath}: ${describeCause(cause)}. ${FILE_STATE_SENTENCE[fileState]} ` +
        'Check that the file and its folder are owned by you and writable ' +
        `(for example: chmod u+rw "${dbPath}") and that the location is not read-only.`,
      dbPath,
      cause,
    );
  }
}

/**
 * Positive corruption evidence, but the file was not repaired (read-only open, a race, or damage
 * found once the open was under way); `fileState` says what the open had done to it by then.
 */
export class DatabaseCorruptError extends DatabaseOpenError {
  override readonly name = 'DatabaseCorruptError';

  constructor(dbPath: string, cause?: unknown, fileState: FileState = 'unmodified') {
    super(
      `${dbPath} is not a valid SQLite database (${describeCause(cause)}). ` +
        `${FILE_STATE_SENTENCE[fileState]} Move it aside yourself, or restore it from a ` +
        'backup, then run CommandVault again to create a new one.',
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

/** What is known about the build that wrote a database this build cannot read. */
export interface NewerSchemaDetails {
  readonly databaseVersion: number;
  readonly supportedVersion: number;
  /** The package version of the newest build that migrated the file, if it says so. */
  readonly writtenBy?: string | undefined;
}

/**
 * The file was written by a newer schema than this build knows and does not say that an older
 * build may read it. Opening it could damage data this build cannot keep consistent, so nothing is
 * read beyond the version records and nothing is written.
 */
export class SchemaTooNewError extends DatabaseOpenError {
  override readonly name = 'SchemaTooNewError';
  readonly databaseVersion: number;
  readonly supportedVersion: number;
  readonly writtenBy: string | undefined;

  constructor(dbPath: string, details: NewerSchemaDetails) {
    const writer =
      details.writtenBy === undefined
        ? 'a newer version of CommandVault'
        : `CommandVault ${details.writtenBy}`;
    super(
      `${dbPath} was written by ${writer} (database schema ${details.databaseVersion}; this ` +
        `version understands schema ${details.supportedVersion} and older). Opening it with this ` +
        'older version could damage it, so it was left exactly as it is. Upgrade CommandVault ' +
        '(update the VS Code extension, or run `npm install -g @commandvault/cli@latest`) and try again.',
      dbPath,
    );
    this.databaseVersion = details.databaseVersion;
    this.supportedVersion = details.supportedVersion;
    this.writtenBy = details.writtenBy;
  }
}

/** The copy taken before a migration could not be written, so the migration did not happen. */
export class MigrationBackupError extends DatabaseOpenError {
  override readonly name = 'MigrationBackupError';
  readonly backupPath: string;

  constructor(dbPath: string, backupPath: string, cause?: unknown) {
    super(
      `Cannot upgrade ${dbPath}: the safety backup ${backupPath} could not be written ` +
        `(${describeCause(cause)}). Nothing was migrated and no data was changed. Free some disk ` +
        'space or fix the permissions of that folder, then try again.',
      dbPath,
      cause,
    );
    this.backupPath = backupPath;
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

type TypedErrorFactory = (
  dbPath: string,
  cause: unknown,
  fileState: FileState,
) => DatabaseOpenError;

const ERROR_FOR_KIND: Readonly<Record<Exclude<OpenErrorKind, 'unknown'>, TypedErrorFactory>> = {
  'native-addon': (dbPath, cause) => new NativeAddonUnavailableError(dbPath, cause),
  locked: (dbPath, cause, fileState) => new DatabaseLockedError(dbPath, cause, fileState),
  permission: (dbPath, cause, fileState) => new DatabasePermissionError(dbPath, cause, fileState),
  corrupt: (dbPath, cause, fileState) => new DatabaseCorruptError(dbPath, cause, fileState),
  io: (dbPath, cause) => new DatabaseIoError(dbPath, cause),
};

/**
 * The typed error for a raw open failure; unknown failures come back untouched, stack included.
 * `fileState` is what the open had done to the file when it failed; see FileState.
 */
export function toOpenError(
  error: unknown,
  dbPath: string,
  fileState: FileState = 'unmodified',
): unknown {
  if (error instanceof DatabaseOpenError) return error;
  const kind = classifyOpenError(error);
  return kind === 'unknown' ? error : ERROR_FOR_KIND[kind](dbPath, error, fileState);
}
