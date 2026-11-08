import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseAdapter } from './database-adapter.js';
import { createDatabaseAdapter } from './database-factory.js';
import {
  DatabaseCorruptError,
  DatabaseLockedError,
  DatabaseOpenError,
  classifyOpenError,
  describeCause,
  errorCode,
  errorMessage,
  toOpenError,
} from './db-errors.js';
import { KNOWN_SCHEMA_VERSION, readEngineMeta } from './migrations.js';
import { OWNER_ONLY_MODE, isProcessRunning, orWhenMissing } from './quarantine-fs.js';
import { QUARANTINE_LOCK_WAIT_MS, withQuarantineLock } from './quarantine-lock.js';
import { waitForOpeners } from './quarantine-openers.js';
import { SqlJsAdapter } from './sqljs-adapter.js';

/**
 * Backups of vault.db and restores from them.
 *
 * A backup is taken with VACUUM INTO over a read-only connection, so it holds every committed
 * change, including those still in the write-ahead log of a running or killed writer; a byte copy
 * of the main file would miss all of them. A restore never trusts the file it is given: it is
 * inspected on a private staged copy (the sql.js adapter repairs a corrupt file in place, so the
 * original is never opened), then installed by rename.
 *
 * Invariant of restoreVault: at every instant vault.db is either the old content, with the commits
 * of its write-ahead log folded in (the checkpoint) or saved beside it (the pre-restore copy), or
 * the new content. A kill before the rename leaves the old content, a stage and a pre-restore copy;
 * a kill after it leaves the new content. The one risk that remains is an idle foreign connection:
 * it cannot be seen (only a connection inside a read reports `busy`), reads stale data after the
 * rename and deletes the new file's -wal/-shm by name when it closes.
 */

const BACKUP_DIR = 'backups';
const PRIVATE_DIR_MODE = 0o700;
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;
const KEPT_PRE_RESTORE_COPIES = 3;
const SQLITE_HEADER = 'SQLite format 3\0';
/** A database is at least its 100-byte header; a shorter file is not one, whatever it holds. */
const SQLITE_MIN_BYTES = 100;
const STAGE_INFIX = '.restore.';
const INSPECT_INFIX = '.inspect.';
/** `<backup>.inspect.<pid>.tmp`, and what the adapters may leave beside it: sidecars, repair litter. */
const INSPECT_COPY_FILE = /\.inspect\.(\d+)\.tmp(?:-wal|-shm|-journal|\.corrupt\..+)?$/;
/** What the adapters leave beside a file they repaired (quarantine.ts): proof it was corrupt. */
const QUARANTINE_INFIX = '.corrupt.';
const MANUAL_BACKUP_FILE = /^vault-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/;
// The same shape migrations.ts gives its safety copies (its regex is private to that module).
const PRE_MIGRATE_FILE = /^pre-migrate-v\d+-\d{8}T\d{9}Z(?:-\d+)?\.db$/;
const PRE_RESTORE_FILE = /^pre-restore-\d{8}T\d{9}Z\.db$/;
const IGNORED_MODE_ERRORS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES']);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READONLY = { readonly: true, walMode: false } as const;

/**
 * `consistent`: VACUUM INTO succeeded and quick_check agrees. `damaged`: a page-for-page copy of
 * a database with a damaged page. `raw`: SQLite could not open the file; its bytes and sidecars.
 */
export type BackupKind = 'consistent' | 'damaged' | 'raw';

export interface BackupResult {
  readonly kind: BackupKind;
  readonly bytes: number;
  /** Why `vault restore` will refuse this copy; only for `damaged` and `raw`. */
  readonly warning?: string;
}

export interface BackupInfo {
  readonly schemaVersion: number;
  readonly entries: number;
  readonly bytes: number;
  readonly journalMode: 'wal' | 'delete';
}

export interface RestoreResult {
  /** The copy of the database as it was, in the backups folder. */
  readonly preRestore: string;
  readonly info: BackupInfo;
}

export interface RestoreOptions {
  /** How long to wait for another CommandVault process (its open, its repair lock, its read). */
  readonly waitMs?: number;
}

export type BackupFileKind = 'manual' | 'pre-migrate' | 'pre-restore';

export type BackupRejectReason =
  'not-a-file' | 'not-sqlite' | 'corrupt' | 'missing-tables' | 'newer-schema';

/** A backup `inspectBackup` refused. `detail` is the reason as a sentence without the path. */
export class BackupRejectedError extends DatabaseOpenError {
  override readonly name = 'BackupRejectedError';
  readonly reason: BackupRejectReason;
  readonly backupPath: string;
  readonly detail: string;

  constructor(backupPath: string, reason: BackupRejectReason, detail: string, cause?: unknown) {
    super(`Refusing to restore ${backupPath}: ${detail}.`, backupPath, cause);
    this.reason = reason;
    this.backupPath = backupPath;
    this.detail = detail;
  }
}

/** The kind of backup a file name denotes; undefined for any other name. */
export function backupFileKind(name: string): BackupFileKind | undefined {
  if (MANUAL_BACKUP_FILE.test(name)) return 'manual';
  if (PRE_MIGRATE_FILE.test(name)) return 'pre-migrate';
  if (PRE_RESTORE_FILE.test(name)) return 'pre-restore';
  return undefined;
}

function warn(message: string): void {
  process.stderr.write(`CommandVault: ${message}\n`);
}

function removeQuietly(path: string): void {
  orWhenMissing(undefined, () => unlinkSync(path));
}

/**
 * Removes a backup and the -wal and -shm beside it (a `raw` copy keeps its sidecars), sidecars
 * first so that an interruption never leaves sidecars without their file. A file that is not
 * there is not an error.
 */
export function removeBackupFiles(path: string): void {
  for (const suffix of SIDECAR_SUFFIXES) removeQuietly(path + suffix);
  removeQuietly(path);
}

function fileSize(path: string): number {
  return orWhenMissing(0, () => lstatSync(path).size);
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Opens `path` for reading without following a symbolic link; a folder or device is refused. */
function openNoFollow(path: string): number {
  if (NO_FOLLOW === 0 && lstatSync(path).isSymbolicLink()) {
    throw withCode(`${path} is a symbolic link`, 'ELOOP');
  }
  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  throw withCode(`${path} is not a regular file`, 'EISDIR');
}

/** Writes the whole of the open file `fd` to a new owner-only file `to` and flushes it. */
function writeCopy(fd: number, to: string): number {
  const content = readFileSync(fd);
  const target = openSync(to, 'wx', OWNER_ONLY_MODE);
  try {
    writeFileSync(target, content);
    fsyncSync(target);
  } finally {
    closeSync(target);
  }
  return content.length;
}

function copyNoFollow(from: string, to: string): number {
  const fd = openNoFollow(from);
  try {
    return writeCopy(fd, to);
  } finally {
    closeSync(fd);
  }
}

/** The live database must be a regular file: the adapters create a file that is not there. */
function assertDatabaseFile(dbPath: string): void {
  if (!lstatSync(dbPath).isFile()) {
    throw new DatabaseOpenError(`${dbPath} is not a regular file. Database not modified.`, dbPath);
  }
}

/** A read-only open never repairs the file; the one failure that says something about it. */
async function openReadonly(path: string): Promise<DatabaseAdapter | DatabaseCorruptError> {
  try {
    return await createDatabaseAdapter(path, READONLY);
  } catch (error) {
    if (error instanceof DatabaseCorruptError) return error;
    throw error;
  }
}

/**
 * sql.js copies the file's bytes and cannot read a write-ahead log, so a -wal a native process
 * filled holds commits the copy would lack; the copy would be stale and must not be taken.
 */
function assertNoForeignWal(conn: DatabaseAdapter, dbPath: string): void {
  if (!(conn instanceof SqlJsAdapter) || fileSize(`${dbPath}-wal`) === 0) return;
  throw new DatabaseOpenError(
    `Cannot copy ${dbPath}: its write-ahead log holds changes a native CommandVault process has ` +
      'not yet saved into the file. Close that process (VS Code, `vault watch`) or run this ' +
      'command with the native SQLite driver. Database not modified.',
    dbPath,
  );
}

/** What quick_check says; damage it cannot even read past is reported as SQLite's own message. */
function quickCheckVerdict(conn: DatabaseAdapter): string {
  try {
    const rows = conn.queryAll<{ quick_check: string }>('PRAGMA quick_check');
    return rows.map((row) => row.quick_check).join('; ');
  } catch (error) {
    if (classifyOpenError(error) !== 'corrupt') throw error;
    return describeCause(error);
  }
}

function reasonOf(error: DatabaseCorruptError): string {
  return error.cause === undefined ? error.message : describeCause(error.cause);
}

function hasTable(conn: DatabaseAdapter, name: string): boolean {
  const sql = "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = $name";
  return conn.queryOne(sql, { $name: name }) !== undefined;
}

/** Every CommandVault database, 0.1.0 included, has both; a file without them is not one. */
function hasRequiredTables(conn: DatabaseAdapter): boolean {
  return hasTable(conn, 'entries') && hasTable(conn, 'schema_version');
}

/** Copies a file SQLite refuses to open as it is, sidecars included, so nothing of it is lost. */
function copyRaw(dbPath: string, destination: string, cause: DatabaseCorruptError): BackupResult {
  const created: string[] = [];
  try {
    const bytes = copyNoFollow(dbPath, destination);
    created.push(destination);
    for (const suffix of SIDECAR_SUFFIXES) {
      orWhenMissing(undefined, () => {
        copyNoFollow(dbPath + suffix, destination + suffix);
        created.push(destination + suffix);
      });
    }
    const warning =
      `copied as is; SQLite reports ${reasonOf(cause)}; vault restore will refuse it until ` +
      'it is repaired';
    return { kind: 'raw', bytes, warning };
  } catch (error) {
    for (const path of created) removeQuietly(path);
    throw toOpenError(error, dbPath);
  }
}

/**
 * quick_check's answer about the copy, or why it is no CommandVault database although SQLite
 * opens it: a file emptied by an adapter's in-place repair opens and passes quick_check.
 */
function copyVerdict(conn: DatabaseAdapter, bytes: number): string {
  const verdict = quickCheckVerdict(conn);
  if (verdict !== 'ok' || hasRequiredTables(conn)) return verdict;
  return `it holds no entries or schema_version table, ${bytes} bytes`;
}

/** Opens the copy read-only and asks SQLite; a copy it cannot open at all is damaged as well. */
async function judgeCopy(destination: string): Promise<BackupResult> {
  const bytes = fileSize(destination);
  const opened = await openReadonly(destination);
  let verdict: string;
  if (opened instanceof DatabaseCorruptError) {
    verdict = reasonOf(opened);
  } else {
    try {
      verdict = copyVerdict(opened, bytes);
    } finally {
      opened.close();
    }
  }
  if (verdict === 'ok') return { kind: 'consistent', bytes };
  const warning =
    `the copy keeps the damage of the database (${verdict}); vault restore will refuse it ` +
    'until it is repaired';
  return { kind: 'damaged', bytes, warning };
}

/**
 * A consistent copy of `dbPath` at `destination` (which must not exist), owner-only, in rollback
 * journal mode, holding every committed change whether or not it was checkpointed yet. A damaged
 * database is copied page for page (`damaged`); one SQLite cannot open is copied byte for byte with
 * its sidecars (`raw`). Throws the typed open errors; ENOENT when there is no database.
 */
export async function backupVault(dbPath: string, destination: string): Promise<BackupResult> {
  assertDatabaseFile(dbPath);
  const conn = await openReadonly(dbPath);
  if (conn instanceof DatabaseCorruptError) return copyRaw(dbPath, destination, conn);
  try {
    assertNoForeignWal(conn, dbPath);
    conn.backupTo(destination);
  } catch (error) {
    // backupTo creates the destination itself; an EEXIST means the file was someone else's.
    if (errorCode(error) !== 'EEXIST') removeQuietly(destination);
    throw toOpenError(error, dbPath);
  } finally {
    conn.close();
  }
  return judgeCopy(destination);
}

/**
 * Copies `path` to the new owner-only file `copy`, refusing anything that is not a regular file
 * starting with the SQLite header. The copy is what gets opened: never `path` itself.
 */
function stageBackup(path: string, copy: string): void {
  let fd: number;
  try {
    fd = openNoFollow(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw error;
    const detail = 'it is not a regular file (a symbolic link or a folder, for example)';
    throw new BackupRejectedError(path, 'not-a-file', detail, error);
  }
  try {
    const size = fstatSync(fd).size;
    const header = Buffer.alloc(SQLITE_HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    if (size < SQLITE_MIN_BYTES || header.toString('latin1') !== SQLITE_HEADER) {
      throw new BackupRejectedError(
        path,
        'not-sqlite',
        `it is not a SQLite database file (${size} bytes)`,
      );
    }
    writeCopy(fd, copy);
  } finally {
    closeSync(fd);
  }
}

function quarantineLitter(copy: string): string[] {
  const prefix = `${basename(copy)}${QUARANTINE_INFIX}`;
  return orWhenMissing([], () => readdirSync(dirname(copy))).filter((name) =>
    name.startsWith(prefix),
  );
}

/** Removes a staged copy and what the adapters may leave beside it: sidecars, repair litter. */
function removeStaged(copy: string, keepCopy = false): void {
  if (!keepCopy) removeQuietly(copy);
  for (const suffix of [...SIDECAR_SUFFIXES, '-journal']) removeQuietly(copy + suffix);
  for (const name of quarantineLitter(copy)) removeQuietly(join(dirname(copy), name));
}

/**
 * The rule of the private `assertNotNewer` in migrations.ts (not in this module's hands): a file
 * ahead of this build is accepted only if the build that wrote it declared a floor this one meets.
 */
function assertKnownSchema(conn: DatabaseAdapter, backupPath: string, newest: number): void {
  if (newest <= KNOWN_SCHEMA_VERSION) return;
  const declared = readEngineMeta(conn).get('compatible_from') ?? '';
  if (/^\d+$/.test(declared) && Number(declared) <= KNOWN_SCHEMA_VERSION) return;
  const detail =
    `it was written by a newer CommandVault (database schema ${newest}; this version ` +
    `understands schema ${KNOWN_SCHEMA_VERSION} and older)`;
  throw new BackupRejectedError(backupPath, 'newer-schema', detail);
}

function judgeStaged(conn: DatabaseAdapter, copy: string, backupPath: string): BackupInfo {
  // sql.js ignores `readonly` and repairs a corrupt copy in place; what it leaves beside is proof.
  if (quarantineLitter(copy).length > 0) {
    throw new BackupRejectedError(backupPath, 'corrupt', 'SQLite reports it is not a database');
  }
  const verdict = quickCheckVerdict(conn);
  if (verdict !== 'ok') {
    throw new BackupRejectedError(backupPath, 'corrupt', `SQLite's quick_check reports ${verdict}`);
  }
  if (!hasRequiredTables(conn)) {
    const detail =
      'it has no entries or schema_version table, so it is not a CommandVault database';
    throw new BackupRejectedError(backupPath, 'missing-tables', detail);
  }
  const sql = 'SELECT max(version) AS newest FROM schema_version';
  const schemaVersion = conn.queryOne<{ newest: number | null }>(sql)?.newest ?? 0;
  assertKnownSchema(conn, backupPath, schemaVersion);
  const count = conn.queryOne<{ n: number }>('SELECT count(*) AS n FROM entries');
  const mode = conn.queryOne<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode;
  return {
    schemaVersion,
    entries: count?.n ?? 0,
    bytes: fileSize(copy),
    journalMode: mode === 'wal' ? 'wal' : 'delete',
  };
}

async function inspectStaged(copy: string, backupPath: string): Promise<BackupInfo> {
  const conn = await openReadonly(copy);
  if (conn instanceof DatabaseCorruptError) {
    throw new BackupRejectedError(backupPath, 'corrupt', `SQLite reports ${reasonOf(conn)}`, conn);
  }
  try {
    return judgeStaged(conn, copy, backupPath);
  } finally {
    conn.close();
  }
}

/**
 * What a backup holds, judged on a private copy under `scratchDir` that is removed afterwards:
 * `path` itself is never opened with SQLite. Throws BackupRejectedError for a file that is not a
 * regular file, not a SQLite database, damaged, not a CommandVault database or written by a newer
 * schema; ENOENT when there is no file.
 */
export async function inspectBackup(path: string, scratchDir: string): Promise<BackupInfo> {
  const copy = join(scratchDir, `${basename(path)}${INSPECT_INFIX}${process.pid}.tmp`);
  try {
    stageBackup(path, copy);
    return await inspectStaged(copy, path);
  } finally {
    removeStaged(copy);
  }
}

/** Whether `pid` names a process that is gone; this one and any that still runs are not. */
function isGoneProcess(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isProcessRunning(pid);
}

/**
 * Removes the staged copies of `inspectBackup` that a process killed while it inspected left in
 * `dir`: a full copy of a backup each, which nothing else would ever clear. The copy of a process
 * that still runs, this one included, may be in use and stays. Never throws: it runs before
 * commands that must not fail because of a file it cannot remove.
 */
export function sweepStaleInspectCopies(dir: string): void {
  for (const name of listQuietly(dir)) {
    const pid = Number(INSPECT_COPY_FILE.exec(name)?.[1]);
    if (!isGoneProcess(pid)) continue;
    try {
      removeQuietly(join(dir, name));
    } catch (error) {
      warn(`could not remove ${join(dir, name)}: ${errorMessage(error)}`);
    }
  }
}

/** A folder is wanted 0700 and a regular file 0600; anything else (a symlink too) is left alone. */
function isOfWantedKind(stats: Stats, wanted: number): boolean {
  return wanted === PRIVATE_DIR_MODE ? stats.isDirectory() : stats.isFile();
}

function setMode(path: string, wanted: number): void {
  try {
    const stats = lstatSync(path);
    if (stats.uid !== process.getuid?.() || !isOfWantedKind(stats, wanted)) return;
    if ((stats.mode & 0o777) !== wanted) chmodSync(path, wanted);
  } catch (error) {
    if (IGNORED_MODE_ERRORS.has(errorCode(error) ?? '')) return;
    warn(`could not make ${path} private: ${errorMessage(error)}`);
  }
}

/** The names in `dir`; none when it is missing, not a folder or not ours to list. Never throws. */
function listQuietly(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (!IGNORED_MODE_ERRORS.has(errorCode(error) ?? '')) {
      warn(`could not list ${dir}: ${errorMessage(error)}`);
    }
    return [];
  }
}

/**
 * Re-applies owner-only modes to the data directory, the database and its sidecars, and the
 * backups folder and the regular files in it. Modes were only ever set on creation, so a vault
 * made by an older build kept 0755/0644. Symbolic links, a folder where a file belongs (and the
 * other way round) and anything owned by someone else are left alone; nothing here throws, since
 * every command runs it. Does nothing on Windows.
 */
export function ensurePrivate(dbPath: string): void {
  if (process.platform === 'win32') return;
  const backups = join(dirname(dbPath), BACKUP_DIR);
  setMode(dirname(dbPath), PRIVATE_DIR_MODE);
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) setMode(dbPath + suffix, OWNER_ONLY_MODE);
  setMode(backups, PRIVATE_DIR_MODE);
  for (const name of listQuietly(backups)) setMode(join(backups, name), OWNER_ONLY_MODE);
}

/** A stage left by a killed restore names a process that no longer runs (or this one, reused). */
function isStaleStage(pid: number): boolean {
  return pid === process.pid || (Number.isInteger(pid) && pid > 0 && !isProcessRunning(pid));
}

function sweepStaleStages(dbPath: string): void {
  const folder = dirname(dbPath);
  const prefix = `${basename(dbPath)}${STAGE_INFIX}`;
  for (const name of orWhenMissing([], () => readdirSync(folder))) {
    if (!name.startsWith(prefix)) continue;
    if (isStaleStage(Number(name.slice(prefix.length).split('.')[0]))) {
      removeQuietly(join(folder, name));
    }
  }
}

/** Stages `backupPath` beside the database under this process's name and inspects the stage. */
async function prepareStage(dbPath: string, backupPath: string): Promise<[string, BackupInfo]> {
  sweepStaleStages(dbPath);
  const stage = `${dbPath}${STAGE_INFIX}${process.pid}.tmp`;
  try {
    stageBackup(backupPath, stage);
    const info = await inspectStaged(stage, backupPath);
    removeStaged(stage, true);
    return [stage, info];
  } catch (error) {
    removeStaged(stage);
    throw error instanceof DatabaseOpenError ? error : toOpenError(error, dbPath);
  }
}

/** The live database: open read-write when healthy; a damaged one is never opened read-write. */
interface LiveDatabase {
  readonly conn?: DatabaseAdapter;
  readonly damaged?: DatabaseCorruptError;
}

/** Read-only first: a read-write open of a damaged file would repair it in place. */
async function openLiveDatabase(dbPath: string, waitMs: number): Promise<LiveDatabase> {
  const probe = await openReadonly(dbPath);
  if (probe instanceof DatabaseCorruptError) return { damaged: probe };
  probe.close();
  return { conn: await createDatabaseAdapter(dbPath, { walMode: false, busyTimeout: waitMs }) };
}

/**
 * Folds the write-ahead log into the file and, in the same step, finds out whether another
 * connection is reading: the checkpoint answers `busy` for one inside a read transaction. An idle
 * connection answers nothing, which is the residual risk named in the module comment.
 */
function foldWriteAheadLog(conn: DatabaseAdapter, dbPath: string): void {
  assertNoForeignWal(conn, dbPath);
  const row = conn.queryOne<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
  if ((row?.busy ?? 0) === 0) return;
  const cause = new Error('another CommandVault process is reading the database');
  throw new DatabaseLockedError(dbPath, cause);
}

/** The copy of the database as it is, before anything replaces it; raw for a damaged file. */
function saveLiveDatabase(dbPath: string, live: LiveDatabase): string {
  const dir = join(dirname(dbPath), BACKUP_DIR);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const destination = join(dir, `pre-restore-${stamp}.db`);
  if (live.damaged !== undefined) copyRaw(dbPath, destination, live.damaged);
  else live.conn?.backupTo(destination);
  return destination;
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The typed error for a failed replacement; it names the pre-restore copy once there is one. */
function restoreFailure(error: unknown, dbPath: string, preRestore: string | undefined): unknown {
  if (error instanceof DatabaseOpenError || preRestore === undefined) {
    return toOpenError(error, dbPath);
  }
  const noted = `${errorMessage(error)}; the database as it was is saved as ${preRestore}`;
  return toOpenError(withCode(noted, errorCode(error) ?? ''), dbPath);
}

/** Runs with the repair lock held, so no CommandVault open starts between its steps. */
function replaceDatabase(
  dbPath: string,
  stage: string,
  live: LiveDatabase,
  closeLive: () => void,
  waitMs: number,
): string {
  let preRestore: string | undefined;
  try {
    waitForOpeners(dbPath, waitMs);
    if (live.conn !== undefined) foldWriteAheadLog(live.conn, dbPath);
    preRestore = saveLiveDatabase(dbPath, live);
    // Closing the last connection lets SQLite remove the sidecars itself; a stale one left by a
    // killed writer would otherwise be replayed into the file installed below.
    closeLive();
    for (const suffix of SIDECAR_SUFFIXES) removeQuietly(dbPath + suffix);
    renameSync(stage, dbPath);
    syncDirectory(dirname(dbPath));
    return preRestore;
  } catch (error) {
    removeStaged(stage);
    throw restoreFailure(error, dbPath, preRestore);
  }
}

function prunePreRestoreCopies(dir: string): void {
  const copies = orWhenMissing([], () => readdirSync(dir))
    .filter((name) => PRE_RESTORE_FILE.test(name))
    .sort((a, b) => b.localeCompare(a));
  for (const name of copies.slice(KEPT_PRE_RESTORE_COPIES)) {
    try {
      removeBackupFiles(join(dir, name));
    } catch (error) {
      warn(`could not remove ${join(dir, name)}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Replaces `dbPath` with the contents of `backupPath`, after inspecting a staged copy of it and
 * after saving the database as it is to `backups/pre-restore-<stamp>.db` (the newest three are
 * kept). Refuses with BackupRejectedError before anything else exists, with DatabaseLockedError
 * while another process reads the database, and leaves the database untouched in both cases.
 */
export async function restoreVault(
  dbPath: string,
  backupPath: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const waitMs = options.waitMs ?? QUARANTINE_LOCK_WAIT_MS;
  assertDatabaseFile(dbPath);
  const [stage, info] = await prepareStage(dbPath, backupPath);
  let live: LiveDatabase;
  try {
    live = await openLiveDatabase(dbPath, waitMs);
  } catch (error) {
    removeStaged(stage);
    throw error;
  }
  let isOpen = live.conn !== undefined;
  const closeLive = (): void => {
    if (!isOpen) return;
    isOpen = false;
    live.conn?.close();
  };
  let preRestore: string;
  try {
    preRestore = withQuarantineLock(dbPath, waitMs, () =>
      replaceDatabase(dbPath, stage, live, closeLive, waitMs),
    );
  } catch (error) {
    // Taking the lock can fail before replaceDatabase runs (something that is not a lock file sits
    // at its path, a holder outlasts waitMs); the stage is this run's to remove then as well.
    removeStaged(stage);
    throw error;
  } finally {
    closeLive();
  }
  prunePreRestoreCopies(join(dirname(dbPath), BACKUP_DIR));
  return { preRestore, info };
}
