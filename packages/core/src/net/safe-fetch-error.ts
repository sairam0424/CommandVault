/** Why a remote fetch was refused or failed; the only vocabulary callers branch on. */
export type SafeFetchCode =
  | 'invalid_url'
  | 'blocked_host'
  | 'dns'
  | 'headers_timeout'
  | 'idle_timeout'
  | 'total_timeout'
  | 'too_large'
  | 'redirect'
  | 'http_status'
  | 'tls'
  | 'unsupported_encoding'
  | 'network';

export interface SafeFetchErrorOptions {
  /** The HTTP status, for `redirect` and `http_status`. */
  readonly status?: number;
  /** The underlying Node error (a DNS, socket or TLS failure). */
  readonly cause?: unknown;
}

/**
 * A fetch that was refused before any socket opened, or that failed on the wire. Messages are
 * built from local text, the normalised host, the address and Node error codes only: nothing the
 * remote end sent (status text, headers, body bytes) ever reaches a message, so printing one
 * cannot relay an attacker's string to the terminal.
 */
export class SafeFetchError extends Error {
  readonly code: SafeFetchCode;
  readonly status?: number;

  constructor(code: SafeFetchCode, message: string, options: SafeFetchErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SafeFetchError';
    this.code = code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
