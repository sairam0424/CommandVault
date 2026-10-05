import { readFile, stat } from 'node:fs/promises';
import { BYTES_PER_MIB, MAX_PARSE_FILE_BYTES } from '../constants.js';
import type { ParseError } from '../types/index.js';

/** Raised before any byte is read, when a file is bigger than the parse read limit. */
export class FileTooLargeError extends Error {
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(filePath: string, sizeBytes: number, limitBytes: number) {
    const mib = (sizeBytes / BYTES_PER_MIB).toFixed(1);
    super(`${filePath} is ${sizeBytes} bytes (${mib} MiB), over the ${limitBytes} byte read limit`);
    this.name = 'FileTooLargeError';
    this.filePath = filePath;
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Reads a UTF-8 text file after checking its size with `stat`, so an oversized file costs no memory.
 * Any other failure (missing file, permissions) propagates unchanged.
 */
export async function readBoundedText(
  filePath: string,
  maxBytes: number = MAX_PARSE_FILE_BYTES,
): Promise<string> {
  const { size } = await stat(filePath);
  if (size > maxBytes) throw new FileTooLargeError(filePath, size, maxBytes);
  return readFile(filePath, 'utf-8');
}

/** A skipped oversized file is a warning: the rest of the scan is unaffected. */
export function skippedTooLarge(error: FileTooLargeError, label: string): ParseError {
  return {
    filePath: error.filePath,
    message: `Skipped ${label}: ${error.message}`,
    severity: 'warning',
    cause: error,
  };
}

/**
 * Classifies a failed file read: an oversized file becomes a skip warning, anything else is an
 * error whose message starts with `failedPrefix`.
 */
export function describeFileFailure(
  err: unknown,
  filePath: string,
  failedPrefix: string,
  label: string,
): ParseError {
  if (err instanceof FileTooLargeError) return skippedTooLarge(err, label);
  const reason = err instanceof Error ? err.message : String(err);
  return { filePath, message: `${failedPrefix}: ${reason}`, severity: 'error', cause: err };
}
