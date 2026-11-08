import { lookup as dnsLookup } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  assertRemoteUrl,
  blockedHostError,
  isAllowListed,
  isBlockedAddress,
  remoteHostOf,
  type RemoteUrlOptions,
} from './address-policy.js';
import { BodyCollector } from './body-collector.js';
import { SafeFetchError } from './safe-fetch-error.js';
import { USER_AGENT } from './user-agent.js';

export { assertRemoteUrl, isBlockedAddress } from './address-policy.js';
export type { RemoteUrlOptions } from './address-policy.js';
export { SafeFetchError } from './safe-fetch-error.js';
export type { SafeFetchCode } from './safe-fetch-error.js';

/**
 * The only place core opens a network connection. The URL is checked before any socket, the
 * hostname is resolved once and every answer must pass the address policy, then the connection is
 * PINNED to those answers (the socket's `lookup` never resolves again, so the name cannot rebind
 * between the check and the connect). Redirects are refused, headers/idle/total deadlines close
 * the socket, and the body is capped while it streams. Plain `node:https`: no new dependency.
 */

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** `dns.lookup(hostname, { all: true }, callback)`: the one shape the fetcher calls. */
export type LookupAll = (
  hostname: string,
  options: { readonly all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: readonly ResolvedAddress[]) => void,
) => void;

export interface SafeFetchOptions extends RemoteUrlOptions {
  /** Resolver for hostnames; `dns.lookup` by default, injected by tests. */
  readonly lookup?: LookupAll;
  /** From request start until the response headers arrive. */
  readonly headersTimeoutMs?: number;
  /** Longest silence between two body chunks. */
  readonly idleTimeoutMs?: number;
  /** From request start until the body is complete. */
  readonly totalTimeoutMs?: number;
  /** The body may not exceed this many bytes; counted as it streams. */
  readonly maxBytes?: number;
}

export interface SafeFetchResult {
  readonly status: number;
  readonly text: string;
}

export const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const MIB = 1024 * 1024;
export const DEFAULT_MAX_BYTES = 10 * MIB;

const HTTPS_PORT = 443;
const MS_PER_SECOND = 1000;
const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 400;
const IDENTITY_ENCODING = 'identity';
const CHUNKED_TRANSFER_CODING = 'chunked';

interface Limits {
  readonly headersTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxBytes: number;
}

function limitsFrom(options: SafeFetchOptions): Limits {
  return {
    headersTimeoutMs: options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
}

function seconds(ms: number): string {
  return `${ms / MS_PER_SECOND} s`;
}

function describeBytes(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;
}

function tooLarge(maxBytes: number): SafeFetchError {
  return new SafeFetchError('too_large', `Response exceeds ${describeBytes(maxBytes)}`);
}

function codeOf(error: unknown): string {
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === 'string' && code !== '') {
    return code;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

/** Fetches the text at an HTTPS URL under the address policy, deadlines and byte cap above. */
export async function safeFetchText(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const target = assertRemoteUrl(url, options);
  // The very host the URL was judged by: one parse, one value, checked and then connected to.
  const host = remoteHostOf(target);
  const limits = limitsFrom(options);
  const startedAt = Date.now();
  // The headers deadline runs from request start, so it also bounds a resolver that never answers.
  const addresses = await withDeadline(resolveVetted(host, options), limits.headersTimeoutMs, () =>
    resolutionTimeout(host, limits.headersTimeoutMs),
  );
  return performRequest(target, host, addresses, limits, Date.now() - startedAt);
}

function resolutionTimeout(host: string, headersTimeoutMs: number): SafeFetchError {
  return new SafeFetchError(
    'headers_timeout',
    `no response headers within ${seconds(headersTimeoutMs)} (still resolving "${host}")`,
  );
}

/** `promise`, or `onExpire()` as the rejection when it has not settled within `ms`. */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onExpire: () => SafeFetchError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onExpire()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** What is left of a deadline that started `elapsedMs` ago; never negative. */
function remaining(limitMs: number, elapsedMs: number): number {
  return Math.max(limitMs - elapsedMs, 0);
}

/**
 * The addresses the connection may use: the literal itself, or every address the name resolves
 * to. Each must pass {@link isBlockedAddress} unless the host is on the allow-list, a literal
 * included: this is the last check before a socket, so it does not rely on the URL check alone.
 */
export async function resolveVetted(
  host: string,
  options: SafeFetchOptions,
): Promise<readonly ResolvedAddress[]> {
  const allowed = isAllowListed(host, options.allowPrivateHosts);
  const family = isIP(host);
  if (family !== 0) {
    if (!allowed && isBlockedAddress(host)) {
      throw blockedHostError(host, host);
    }
    return [{ address: host, family }];
  }
  const addresses = await lookupAll(host, options.lookup ?? (dnsLookup as LookupAll));
  if (allowed) {
    return addresses;
  }
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked !== undefined) {
    throw blockedHostError(host, blocked.address);
  }
  return addresses;
}

function lookupAll(host: string, lookup: LookupAll): Promise<readonly ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string, cause?: unknown): void =>
      reject(new SafeFetchError('dns', `Cannot resolve "${host}" (${reason})`, { cause }));
    try {
      lookup(host, { all: true }, (error, addresses) => {
        if (error) {
          fail(codeOf(error), error);
          return;
        }
        const usable = (addresses ?? []).filter((entry) => isIP(entry.address) !== 0);
        if (usable.length === 0) {
          fail('no addresses');
          return;
        }
        resolve(usable);
      });
    } catch (error) {
      fail(codeOf(error), error);
    }
  });
}

type RequestedFamily = number | string | undefined;

function familyNumber(family: RequestedFamily): number {
  if (family === 'IPv4' || family === 4) return 4;
  if (family === 'IPv6' || family === 6) return 6;
  return 0;
}

/**
 * The socket's resolver, answering only from the vetted list and never looking anything up. Node
 * asks with `all: true` when it may try several addresses (the default) and for a single address
 * otherwise; both shapes are answered.
 */
function pinnedLookup(vetted: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = familyNumber(options.family);
    const matching = wanted === 0 ? vetted : vetted.filter((entry) => entry.family === wanted);
    const chosen = matching.length > 0 ? matching : vetted;
    const first = chosen[0] as ResolvedAddress;
    process.nextTick(() => {
      if (options.all === true) {
        callback(
          null,
          chosen.map((entry) => ({ address: entry.address, family: entry.family })),
        );
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

function requestOptions(
  target: URL,
  host: string,
  addresses: readonly ResolvedAddress[],
): RequestOptions {
  // `servername` is left to Node: the hostname for a name (SNI and the certificate check stay on
  // the name the user typed), nothing for an IP literal. No Accept-Encoding: the byte cap counts
  // the bytes that arrive, so nothing may be compressed.
  return {
    host,
    port: target.port === '' ? HTTPS_PORT : Number(target.port),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    agent: false,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    lookup: pinnedLookup(addresses),
  };
}

/** The three deadlines of one transfer; a fired timer hands its error to `onExpire`. */
class TransferTimers {
  private headers: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout | undefined;
  private total: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly limits: Limits,
    private readonly onExpire: (error: SafeFetchError) => void,
  ) {}

  /** `elapsedMs` already went to resolution; the messages still name the full limits. */
  start(elapsedMs: number): void {
    const { headersTimeoutMs, totalTimeoutMs } = this.limits;
    this.headers = setTimeout(
      () => {
        this.onExpire(
          new SafeFetchError(
            'headers_timeout',
            `no response headers within ${seconds(headersTimeoutMs)}`,
          ),
        );
      },
      remaining(headersTimeoutMs, elapsedMs),
    );
    this.total = setTimeout(
      () => {
        this.onExpire(
          new SafeFetchError(
            'total_timeout',
            `response not complete within ${seconds(totalTimeoutMs)}`,
          ),
        );
      },
      remaining(totalTimeoutMs, elapsedMs),
    );
  }

  headersArrived(): void {
    clearTimeout(this.headers);
    this.dataArrived();
  }

  /** Called for every `data` event, which a peer can make ten million times with tiny chunks. */
  dataArrived(): void {
    if (this.stopped) {
      return;
    }
    if (this.idle !== undefined) {
      // Re-arms the same timer. Replacing it per event costs about ten times as much CPU.
      this.idle.refresh();
      return;
    }
    const { idleTimeoutMs } = this.limits;
    this.idle = setTimeout(() => {
      this.onExpire(new SafeFetchError('idle_timeout', `no data for ${seconds(idleTimeoutMs)}`));
    }, idleTimeoutMs);
  }

  clear(): void {
    this.stopped = true;
    clearTimeout(this.headers);
    clearTimeout(this.idle);
    clearTimeout(this.total);
  }
}

/** Where the connection got to, so a failure can be told apart: TCP connected, TLS established. */
class HandshakePhase {
  connected = false;
  secured = false;

  watch(request: ClientRequest): void {
    request.on('socket', (socket) => {
      socket.once('connect', () => {
        this.connected = true;
      });
      socket.once('secureConnect', () => {
        this.secured = true;
      });
    });
  }
}

const TLS_CODE = /^ERR_TLS_|^ERR_SSL_|CERT|^EPROTO$/;

function classifyFailure(error: unknown, host: string, phase: HandshakePhase): SafeFetchError {
  if (error instanceof SafeFetchError) {
    return error;
  }
  const code = codeOf(error);
  if ((phase.connected && !phase.secured) || TLS_CODE.test(code)) {
    return new SafeFetchError('tls', `TLS handshake with "${host}" failed (${code})`, {
      cause: error,
    });
  }
  return new SafeFetchError('network', `Connection to "${host}" failed (${code})`, {
    cause: error,
  });
}

interface Transfer {
  readonly limits: Limits;
  readonly timers: TransferTimers;
  fail(error: SafeFetchError): void;
  succeed(result: SafeFetchResult): void;
}

/** Refuses the response on its headers alone, or returns undefined when the body may be read. */
function headerRefusal(response: IncomingMessage, limits: Limits): SafeFetchError | undefined {
  const status = response.statusCode ?? 0;
  if (status >= HTTP_REDIRECT_MIN && status < HTTP_REDIRECT_MAX) {
    return new SafeFetchError('redirect', `redirect refused (HTTP ${status})`, { status });
  }
  if (status < HTTP_SUCCESS_MIN || status >= HTTP_REDIRECT_MIN) {
    return new SafeFetchError('http_status', `HTTP ${status}`, { status });
  }
  // Content-codings are case-insensitive (RFC 9110 8.4.1): "Identity" is no compression. Anything
  // else, a list included, is refused.
  const encoding = response.headers['content-encoding']?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== IDENTITY_ENCODING) {
    return new SafeFetchError(
      'unsupported_encoding',
      'unsupported content-encoding (compressed responses are refused)',
    );
  }
  // Node removes the `chunked` framing and nothing else: under `Transfer-Encoding: gzip, chunked` it
  // hands over the gzip bytes. Plain chunked is the only transfer coding that is read.
  const transferCoding = response.headers['transfer-encoding']?.trim().toLowerCase();
  if (transferCoding !== undefined && transferCoding !== CHUNKED_TRANSFER_CODING) {
    return new SafeFetchError(
      'unsupported_encoding',
      'unsupported transfer-encoding (only chunked is accepted)',
    );
  }
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    return tooLarge(limits.maxBytes);
  }
  return undefined;
}

/**
 * Streams the body under the idle deadline and the byte cap. Each chunk is counted BEFORE it is
 * kept and copied into the collector's blocks, so memory is bounded by the cap whatever the chunk
 * sizes, and the work by the cap and the total deadline.
 */
function readBody(response: IncomingMessage, transfer: Transfer): void {
  const refusal = headerRefusal(response, transfer.limits);
  if (refusal !== undefined) {
    response.resume();
    transfer.fail(refusal);
    return;
  }
  const status = response.statusCode ?? 0;
  const body = new BodyCollector();
  response.on('data', (chunk: Buffer) => {
    transfer.timers.dataArrived();
    if (body.length + chunk.length > transfer.limits.maxBytes) {
      transfer.fail(tooLarge(transfer.limits.maxBytes));
      return;
    }
    body.append(chunk);
  });
  response.on('end', () => {
    transfer.succeed({ status, text: body.text() });
  });
  response.on('aborted', () => {
    transfer.fail(new SafeFetchError('network', 'response aborted by the remote end'));
  });
}

function performRequest(
  target: URL,
  host: string,
  addresses: readonly ResolvedAddress[],
  limits: Limits,
  elapsedMs: number,
): Promise<SafeFetchResult> {
  return new Promise<SafeFetchResult>((resolve, reject) => {
    const request = httpsRequest(requestOptions(target, host, addresses));
    const phase = new HandshakePhase();
    phase.watch(request);
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (!settled) {
        settled = true;
        timers.clear();
        outcome();
      }
    };
    const fail = (error: SafeFetchError): void => {
      settle(() => reject(error));
      request.destroy(error);
    };
    const timers = new TransferTimers(limits, fail);
    const transfer: Transfer = {
      limits,
      timers,
      fail,
      succeed: (result) => settle(() => resolve(result)),
    };
    request.on('response', (response) => {
      timers.headersArrived();
      response.on('error', (error) => fail(classifyFailure(error, host, phase)));
      readBody(response, transfer);
    });
    request.on('error', (error) => fail(classifyFailure(error, host, phase)));
    // Node discards an unsolicited 101 (Upgrade) and destroys the socket with NO error: 'close' is
    // the only event. Nothing that closes before the body has settled this transfer may hang it.
    request.on('close', () =>
      fail(new SafeFetchError('network', `Connection to "${host}" closed without a response`)),
    );
    timers.start(elapsedMs);
    request.end();
  });
}
