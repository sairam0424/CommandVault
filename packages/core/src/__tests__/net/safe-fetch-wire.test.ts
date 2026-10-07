import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeFetchText,
  SafeFetchError,
  type LookupAll,
  type SafeFetchOptions,
} from '../../net/safe-fetch.js';
import {
  FIXTURE_SERVERNAME,
  generateTlsFixture,
  OK_BUNDLE,
  startFixtureServer,
  TRICKLE_WRITES,
  type FixtureServer,
  type TlsFixture,
} from '../helpers/tls-fixture.js';

/**
 * What goes onto the wire and how a body is decoded, against the same loopback TLS fixture as
 * safe-fetch-tls.test.ts: the request's identity, a leading byte order mark, and the spelling of
 * the Content-Encoding value.
 */

const ALLOW = { allowPrivateHosts: [FIXTURE_SERVERNAME] } as const;
const manifest = createRequire(import.meta.url)('../../../package.json') as { version: string };

/** What `promise` rejected with, or undefined when it did not reject. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

interface EchoedRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawHeaders: readonly string[];
}

describe('safeFetchText on the wire', () => {
  let tls: TlsFixture;
  let fixture: FixtureServer;
  let lookup: LookupAll;

  const url = (path: string): string => `https://${FIXTURE_SERVERNAME}:${fixture.port}${path}`;
  const fetchText = (path: string, options: SafeFetchOptions = {}) =>
    safeFetchText(url(path), { ...ALLOW, lookup, ...options });

  beforeAll(async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    tls = generateTlsFixture();
    fixture = await startFixtureServer(tls);
  });

  beforeEach(() => {
    lookup = (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });

  afterAll(async () => {
    await fixture.close();
    tls.dispose();
    vi.unstubAllEnvs();
  });

  describe('the request', () => {
    async function echoed(): Promise<EchoedRequest> {
      return JSON.parse((await fetchText('/echo-request')).text) as EchoedRequest;
    }

    it('names the product and its version in User-Agent, as a plain product token', async () => {
      const { headers } = await echoed();
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(headers['user-agent']).toBe(`commandvault/${manifest.version}`);
    });

    it('sends nothing about the machine: no platform, runtime, user or path', async () => {
      const { headers, rawHeaders } = await echoed();
      const userAgent = headers['user-agent'] ?? '';
      expect(userAgent).toMatch(/^[a-z]+\/[0-9][\w.+-]*$/);
      for (const detail of [process.platform, process.version, process.arch, process.cwd()]) {
        expect(rawHeaders.join('\n')).not.toContain(detail);
      }
    });

    it('still asks for JSON and for no compression', async () => {
      const { headers } = await echoed();
      expect(headers.accept).toBe('application/json');
      expect(headers['accept-encoding']).toBeUndefined();
    });
  });

  describe('the body', () => {
    it('strips a leading UTF-8 byte order mark, as fetch() did', async () => {
      const result = await fetchText('/bom.json');
      expect(result.text.charCodeAt(0)).toBe('{'.charCodeAt(0));
      expect(JSON.parse(result.text)).toEqual(OK_BUNDLE);
    });

    it('returns a body without one unchanged', async () => {
      const result = await fetchText('/ok.json');
      expect(result.text).toBe(JSON.stringify(OK_BUNDLE));
    });
  });

  describe('the byte cap on a body streamed without a Content-Length', () => {
    const CAP = 1_000;

    it('accepts a body of exactly the cap, spread over several chunks', async () => {
      const result = await fetchText(`/chunked/${CAP}`, { maxBytes: CAP });
      expect(result.text).toBe('x'.repeat(CAP));
    });

    it('refuses a body one byte over the cap, and says what the cap was', async () => {
      const failure = await rejection(fetchText(`/chunked/${CAP + 1}`, { maxBytes: CAP }));
      expect(failure).toBeInstanceOf(SafeFetchError);
      expect((failure as SafeFetchError).code).toBe('too_large');
      expect((failure as SafeFetchError).message).toBe('Response exceeds 1000 bytes');
    });
  });

  describe('the idle deadline', () => {
    const IDLE_MS = 300;

    it('runs from the LAST chunk: a body still arriving is not cut, silence after it is', async () => {
      // The route writes a byte every 100 ms for 8 writes (about 700 ms) and then stops. A deadline
      // of 300 ms measured from the first byte would fire during the trickle.
      const before = fixture.trickleWrites.length;
      const failure = await rejection(
        fetchText('/trickle-then-stall', { idleTimeoutMs: IDLE_MS, totalTimeoutMs: 10_000 }),
      );
      const failedAt = Date.now();

      expect(failure).toBeInstanceOf(SafeFetchError);
      expect((failure as SafeFetchError).code).toBe('idle_timeout');
      expect((failure as SafeFetchError).message).toBe('no data for 0.3 s');
      const writes = fixture.trickleWrites.slice(before);
      expect(writes).toHaveLength(TRICKLE_WRITES);
      // A timer cannot fire early: this holds only if every chunk re-armed the deadline.
      const lastWriteAt = writes.at(-1) as number;
      expect(failedAt - lastWriteAt).toBeGreaterThanOrEqual(IDLE_MS - 50);
    });
  });

  describe('Content-Encoding', () => {
    it('accepts "Identity" in any letter case (RFC 9110: content-codings are case-insensitive)', async () => {
      const result = await fetchText('/identity-upper');
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual(OK_BUNDLE);
    });

    it('still refuses a compressed body whatever the letter case', async () => {
      const failure = await rejection(fetchText('/gzip-upper'));
      expect(failure).toBeInstanceOf(SafeFetchError);
      expect((failure as SafeFetchError).code).toBe('unsupported_encoding');
      expect((failure as SafeFetchError).message).not.toMatch(/gzip/i);
    });
  });

  describe('Transfer-Encoding', () => {
    // Node undoes `chunked` and nothing else: under `gzip, chunked` it hands over the gzip bytes.
    // Such a body is never inflated here, but a coding the fetcher does not understand is not
    // something to parse as JSON either: fail closed on anything but plain chunked.
    it('refuses a transfer coding other than chunked', async () => {
      const failure = await rejection(fetchText('/te-gzip-chunked'));
      expect(failure).toBeInstanceOf(SafeFetchError);
      expect((failure as SafeFetchError).code).toBe('unsupported_encoding');
      expect((failure as SafeFetchError).message).toBe(
        'unsupported transfer-encoding (only chunked is accepted)',
      );
    });

    it('accepts chunked in any letter case (RFC 9110: transfer-codings are case-insensitive)', async () => {
      const result = await fetchText('/te-chunked-upper');
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual(OK_BUNDLE);
    });

    it('still reads an ordinary chunked body and one with a Content-Length', async () => {
      expect((await fetchText('/chunked/10', { maxBytes: 10 })).text).toBe('x'.repeat(10));
      expect(JSON.parse((await fetchText('/ok.json')).text)).toEqual(OK_BUNDLE);
    });
  });
});
