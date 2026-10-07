import { constants, type Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { BYTES_PER_MIB, MAX_PARSE_FILE_BYTES } from '../constants.js';
import type { ParseError } from '../types/index.js';

/**
 * Base of every "this file was left out on purpose" failure, so one `instanceof` turns any of them
 * into a warning and the rest of the scan goes on. None carries a `code`: a skip is never one of
 * the transient codes `withRetry` tries again.
 */
export class SkippedFileError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(message);
    this.name = 'SkippedFileError';
    this.filePath = filePath;
  }
}

/** Raised before any byte is read, when a file is bigger than the parse read limit. */
export class FileTooLargeError extends SkippedFileError {
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(filePath: string, sizeBytes: number, limitBytes: number) {
    const mib = (sizeBytes / BYTES_PER_MIB).toFixed(1);
    super(
      filePath,
      `${filePath} is ${sizeBytes} bytes (${mib} MiB), over the ${limitBytes} byte read limit`,
    );
    this.name = 'FileTooLargeError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

export type FileKind =
  'FIFO' | 'character device' | 'block device' | 'directory' | 'socket' | 'other';

/** Raised before any byte is read, when the path is not a regular file (a FIFO would block, a device never ends). */
export class NotRegularFileError extends SkippedFileError {
  readonly kind: FileKind;

  constructor(filePath: string, kind: FileKind) {
    super(filePath, `${filePath} is a ${kind}, not a regular file`);
    this.name = 'NotRegularFileError';
    this.kind = kind;
  }
}

function kindOf(stats: Stats): FileKind {
  if (stats.isFIFO()) return 'FIFO';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSocket()) return 'socket';
  return 'other';
}

/**
 * Read-only, and non-blocking where the platform has the flag (Windows does not): opening a FIFO
 * with no writer then returns at once instead of waiting for one. For a regular file the flag
 * changes nothing. The type check below, not the flag, is what keeps a FIFO out of the index.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
// First buffer for a file whose stat says it is empty (a pseudo file can still hold bytes).
const UNKNOWN_SIZE_BUFFER_BYTES = 64 * 1024;

/**
 * A socket cannot be opened as a file at all (ENXIO on Linux, errno -102 on macOS), so its kind
 * is read from a stat of the path after the open failed. Nothing is read afterwards: this only
 * decides whether the failure is a skip or an error.
 */
async function describeOpenFailure(filePath: string, cause: unknown): Promise<unknown> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? cause : new NotRegularFileError(filePath, kindOf(stats));
  } catch {
    return cause;
  }
}

/** The same contents in a buffer twice as long (never past `ceiling`); `used` bytes are copied. */
function grown(buffer: Buffer, used: number, ceiling: number): Buffer {
  const next = Buffer.allocUnsafe(Math.min(ceiling, buffer.length * 2));
  buffer.copy(next, 0, 0, used);
  return next;
}

/**
 * Reads to end of file, counting bytes: the count is the bound, never the size a stat reported, so
 * a file that grows between the stat and the read is still refused at the limit. One buffer holds
 * the file: sized from the stat plus one byte, so a file of that size is read whole and the next
 * read finds its end at once, and doubled only when the file turns out larger than the stat said.
 * No buffer is ever longer than the limit plus one byte, the first byte that proves a file too big.
 */
async function readCounted(
  handle: FileHandle,
  filePath: string,
  maxBytes: number,
  sizeHint: number,
): Promise<Buffer> {
  const ceiling = maxBytes + 1;
  let buffer: Buffer = Buffer.allocUnsafe(
    Math.min(ceiling, sizeHint > 0 ? sizeHint + 1 : UNKNOWN_SIZE_BUFFER_BYTES),
  );
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
    if (bytesRead === 0) return buffer.subarray(0, total);
    total += bytesRead;
    if (total > maxBytes) throw new FileTooLargeError(filePath, total, maxBytes);
    if (total === buffer.length) buffer = grown(buffer, total, ceiling);
  }
}

/**
 * A judgment of the handle `readBoundedText` just opened, made before any byte is read. It throws
 * to refuse the file (a `SkippedFileError` makes that a warning), and does nothing to accept it.
 * For a caller that validated the path before the open: what the open returned is what counts, not
 * what the path was a moment earlier.
 */
export type OpenedFileCheck = (handle: FileHandle) => Promise<void>;

/**
 * Reads a UTF-8 text file (invalid bytes become U+FFFD, as `readFile(path, 'utf-8')` did) through
 * one handle: the file is opened once, `confirmOpened` (when given) judges that handle, `stat` on
 * it refuses anything that is not a regular file and short-circuits an obviously oversized one
 * before any byte is read, and the read itself is bounded by counting. The size and type checks
 * never re-resolve the path. Any other failure (missing file, permissions) propagates unchanged.
 */
export async function readBoundedText(
  filePath: string,
  maxBytes: number = MAX_PARSE_FILE_BYTES,
  confirmOpened?: OpenedFileCheck,
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, OPEN_FLAGS);
  } catch (err) {
    throw await describeOpenFailure(filePath, err);
  }
  try {
    await confirmOpened?.(handle);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new NotRegularFileError(filePath, kindOf(stats));
    if (stats.size > maxBytes) throw new FileTooLargeError(filePath, stats.size, maxBytes);
    return (await readCounted(handle, filePath, maxBytes, stats.size)).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * A skipped file is a warning: the rest of the scan is unaffected. `filePath` is the path the scan
 * found (a symlink, say); the message names what was actually refused.
 */
export function skippedFile(
  error: SkippedFileError,
  label: string,
  filePath: string = error.filePath,
): ParseError {
  return {
    filePath,
    message: `Skipped ${label}: ${error.message}`,
    severity: 'warning',
    cause: error,
  };
}

/**
 * Classifies a failed file read: a file skipped on purpose (too large, not a regular file, a link
 * that cannot be followed) becomes a warning, anything else an error whose message starts with
 * `failedPrefix`.
 */
export function describeFileFailure(
  err: unknown,
  filePath: string,
  failedPrefix: string,
  label: string,
): ParseError {
  if (err instanceof SkippedFileError) return skippedFile(err, label, filePath);
  const reason = err instanceof Error ? err.message : String(err);
  return { filePath, message: `${failedPrefix}: ${reason}`, severity: 'error', cause: err };
}
