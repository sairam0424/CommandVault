import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_BYTES,
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
  type FixtureServer,
  type TlsFixture,
} from '../helpers/tls-fixture.js';

/**
 * Real sockets on loopback against a TLS server with a certificate for `registry.test`. The
 * injected lookup maps that name to 127.0.0.1 once; everything after that must come from the
 * pinned connection (SNI and Host on the name, the socket on the vetted address).
 */

const MIB = 1024 * 1024;
const SHORT_MS = 300;
/** A resolver this slow, under a deadline of RESOLVE_DELAY_MS + SHORT_MS, leaves the request SHORT_MS. */
const RESOLVE_DELAY_MS = 1_000;
/** Timer jitter on a loaded machine; far below the RESOLVE_DELAY_MS an unbudgeted request would add. */
const SLACK_MS = 700;
/** Without the fix the 101 case never settles; fail it well before vitest's 30 s budget. */
const UPGRADE_CASE_TIMEOUT_MS = 10_000;

/**
 * The fixture name resolves to loopback, which the policy refuses: the allow-list is what lets
 * these cases reach the server, exactly as a user names a private registry in config.json.
 */
const ALLOW = { allowPrivateHosts: [FIXTURE_SERVERNAME] } as const;

async function failure(url: string, options: SafeFetchOptions): Promise<SafeFetchError> {
  try {
    await safeFetchText(url, { ...ALLOW, ...options });
  } catch (err) {
    if (err instanceof SafeFetchError) return err;
    throw err;
  }
  throw new Error(`${url} succeeded`);
}

describe('safeFetchText over TLS on loopback', () => {
  let tls: TlsFixture;
  let fixture: FixtureServer;
  let lookup: ReturnType<typeof vi.fn<LookupAll>>;

  const url = (path: string): string => `https://${FIXTURE_SERVERNAME}:${fixture.port}${path}`;

  beforeAll(async () => {
    tls = generateTlsFixture();
    fixture = await startFixtureServer(tls);
  });

  // Every case gets its own resolver, so each one stands alone (and `-t` can run it alone).
  beforeEach(() => {
    lookup = vi.fn<LookupAll>((_host, _options, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }]),
    );
  });

  afterAll(async () => {
    await fixture.close();
    tls.dispose();
  });

  describe('with certificate verification disabled for the self-signed fixture', () => {
    beforeAll(() => {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('(a) fetches /ok.json through one resolution, with SNI and Host on the name', async () => {
      const before = fixture.requests.length;

      const result = await safeFetchText(url('/ok.json'), { ...ALLOW, lookup });

      expect(result.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual(OK_BUNDLE);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup.mock.calls[0]?.[0]).toBe(FIXTURE_SERVERNAME);
      expect(fixture.servernames.at(-1)).toBe(FIXTURE_SERVERNAME);
      expect(fixture.requests.slice(before)).toEqual([
        { path: '/ok.json', host: `${FIXTURE_SERVERNAME}:${fixture.port}` },
      ]);
    });

    it('(b) /never: headers deadline closes the socket', async () => {
      const started = Date.now();
      const err = await failure(url('/never'), { lookup, headersTimeoutMs: SHORT_MS });
      expect(err.code).toBe('headers_timeout');
      expect(err.message).toBe('no response headers within 0.3 s');
      expect(Date.now() - started).toBeLessThan(2_000);
      await vi.waitFor(() => expect(fixture.closes['/never']).toBe(1));
    });

    it('(b) /stall: idle deadline after the headers', async () => {
      // A short total deadline bounds the case should the idle timer ever stop firing.
      const err = await failure(url('/stall'), {
        lookup,
        idleTimeoutMs: SHORT_MS,
        totalTimeoutMs: 5_000,
      });
      expect(err.code).toBe('idle_timeout');
      expect(err.message).toBe('no data for 0.3 s');
      await vi.waitFor(() => expect(fixture.closes['/stall']).toBe(1));
    });

    it('(b) /slow: total deadline even while bytes trickle in', async () => {
      const err = await failure(url('/slow'), { lookup, totalTimeoutMs: 800 });
      expect(err.code).toBe('total_timeout');
      expect(err.message).toBe('response not complete within 0.8 s');
      await vi.waitFor(() => expect(fixture.closes['/slow']).toBe(1));
    });

    it('(c) /big: the default cap stops a 200 MiB chunked body while it streams', async () => {
      const rssBefore = process.memoryUsage().rss;
      const started = Date.now();

      const err = await failure(url('/big'), { lookup });

      expect(err.code).toBe('too_large');
      expect(err.message).toBe(`Response exceeds ${DEFAULT_MAX_BYTES / MIB} MiB`);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(100 * MIB);
      await vi.waitFor(() => expect(fixture.closes['/big']).toBe(1));
      expect(fixture.bigBytesWritten).toBeLessThan(64 * MIB);
    });

    it('(c) a content-length above the cap is refused before any body is read', async () => {
      const err = await failure(url('/ok.json'), { lookup, maxBytes: 16 });
      expect(err.code).toBe('too_large');
      expect(err.message).toBe('Response exceeds 16 bytes');
    });

    it('(d) /redirect: refused, nothing followed', async () => {
      const before = fixture.requests.length;
      const err = await failure(url('/redirect'), { lookup });
      expect(err.code).toBe('redirect');
      expect(err.status).toBe(302);
      expect(err.message).toBe('redirect refused (HTTP 302)');
      expect(fixture.requests.slice(before)).toHaveLength(1);
    });

    it('(e) /status/503: the number only, never the status text', async () => {
      const err = await failure(url('/status/503'), { lookup });
      expect(err.code).toBe('http_status');
      expect(err.status).toBe(503);
      expect(err.message).toBe('HTTP 503');
      expect(err.message).not.toContain('Service Unavailable');
    });

    it('(f) /gzip: a compressed body is refused instead of decoded', async () => {
      const err = await failure(url('/gzip'), { lookup });
      expect(err.code).toBe('unsupported_encoding');
      expect(err.message).not.toContain('gzip');
    });

    it(
      '(h) /upgrade: an unsolicited 101 settles as a network failure instead of hanging',
      async () => {
        const started = Date.now();
        const err = await failure(url('/upgrade'), { lookup });
        expect(err.code).toBe('network');
        expect(err.message).toBe(`Connection to "${FIXTURE_SERVERNAME}" closed without a response`);
        expect(Date.now() - started).toBeLessThan(2_000);
        await vi.waitFor(() => expect(fixture.closes['/upgrade']).toBe(1));
      },
      UPGRADE_CASE_TIMEOUT_MS,
    );

    it('the headers deadline runs from request start: resolution time counts against it', async () => {
      const slowLookup: LookupAll = (_host, _options, callback) => {
        setTimeout(() => callback(null, [{ address: '127.0.0.1', family: 4 }]), RESOLVE_DELAY_MS);
      };
      const started = Date.now();
      const err = await failure(url('/never'), {
        lookup: slowLookup,
        headersTimeoutMs: RESOLVE_DELAY_MS + SHORT_MS,
      });
      expect(err.code).toBe('headers_timeout');
      expect(err.message).toBe(
        `no response headers within ${(RESOLVE_DELAY_MS + SHORT_MS) / 1000} s`,
      );
      // Not RESOLVE_DELAY_MS plus a full deadline: the budget the resolver used is gone.
      expect(Date.now() - started).toBeLessThan(RESOLVE_DELAY_MS + SHORT_MS + SLACK_MS);
    });

    it('a public IP literal is fetched without SNI', async () => {
      const result = await safeFetchText(`https://127.0.0.1:${fixture.port}/ok.json`, {
        allowPrivateHosts: ['127.0.0.1'],
      });
      expect(result.status).toBe(200);
      expect(fixture.servernames.at(-1)).toBe('');
    });
  });

  it('(g) verification is on by default: the self-signed certificate is a tls failure', async () => {
    const connections = fixture.connections;
    const handshakes = fixture.servernames.length;
    const err = await failure(url('/ok.json'), { lookup });
    expect(err.code).toBe('tls');
    expect(['DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']).toContain(
      (err.cause as NodeJS.ErrnoException).code,
    );
    expect(err.message).toBe(
      `TLS handshake with "${FIXTURE_SERVERNAME}" failed (${(err.cause as NodeJS.ErrnoException).code})`,
    );
    // The client aborts on the certificate, before the server's TLS 1.3 handshake completes.
    await vi.waitFor(() => expect(fixture.connections).toBe(connections + 1));
    expect(fixture.servernames.length).toBe(handshakes);
  });

  it('a closed port is a network failure naming the Node code', async () => {
    const closed = await startFixtureServer(tls);
    await closed.close();
    const err = await failure(`https://${FIXTURE_SERVERNAME}:${closed.port}/x`, { lookup });
    expect(err.code).toBe('network');
    expect(err.message).toBe(`Connection to "${FIXTURE_SERVERNAME}" failed (ECONNREFUSED)`);
  });
});
