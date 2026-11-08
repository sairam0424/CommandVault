import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeFetchText, SafeFetchError, type LookupAll } from '../../net/safe-fetch.js';
import {
  FIXTURE_SERVERNAME,
  generateTlsFixture,
  startFixtureServer,
  TINY_TOTAL_BYTES,
  type FixtureServer,
  type TlsFixture,
} from '../helpers/tls-fixture.js';

/**
 * The byte cap bounds the answer, not the work: a server that sends the body one byte per chunk
 * makes the client handle a `data` event per byte. If every chunk is kept as its own Buffer, a
 * 10 MiB cap means about ten million live Buffer objects (measured: roughly 3 GB of memory) long
 * before `too_large` can fire. The body must be gathered into a few large blocks instead.
 *
 * This file holds ONE test on purpose: the figure is the process's peak memory, and vitest gives
 * each file its own process, so nothing a neighbouring test allocated can hide or add to it.
 */

const KIB = 1024;
const MIB = KIB * KIB;
/** One data event per byte: this many of them under the cap. */
const CAP_BYTES = MIB;
/**
 * A body kept chunk by chunk costs about 400 bytes per chunk: the unfixed fetcher grew by 430 MB
 * at this cap. Gathered into blocks it costs the cap plus the garbage the collector has not yet
 * swept: it grew by about 14 MB. The limit sits well clear of both.
 */
const PEAK_GROWTH_LIMIT_BYTES = 64 * MIB;
const SAMPLE_INTERVAL_MS = 5;
/** Generous: the same transfer takes a few seconds on a loaded machine, a hang takes 30. */
const MAX_ELAPSED_MS = 25_000;
const CASE_TIMEOUT_MS = 40_000;

async function withPeakRss<T>(work: Promise<T>): Promise<{ value: T; growthBytes: number }> {
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sample = (): void => {
    peak = Math.max(peak, process.memoryUsage.rss());
  };
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  try {
    const value = await work;
    sample();
    return { value, growthBytes: peak - baseline };
  } finally {
    clearInterval(timer);
  }
}

describe('safeFetchText with a body sent one byte per chunk', () => {
  let tls: TlsFixture;
  let fixture: FixtureServer;

  beforeAll(async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    tls = generateTlsFixture();
    fixture = await startFixtureServer(tls);
  });

  afterAll(async () => {
    await fixture.close();
    tls.dispose();
    vi.unstubAllEnvs();
  });

  it(
    'is cut at the cap without holding a Buffer per chunk',
    async () => {
      const lookup: LookupAll = (_host, _options, callback) =>
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      const url = `https://${FIXTURE_SERVERNAME}:${fixture.port}/tiny-chunks`;
      const started = Date.now();

      const { value, growthBytes } = await withPeakRss(
        safeFetchText(url, {
          allowPrivateHosts: [FIXTURE_SERVERNAME],
          lookup,
          maxBytes: CAP_BYTES,
        }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      expect(value).toBeInstanceOf(SafeFetchError);
      expect((value as SafeFetchError).code).toBe('too_large');
      expect((value as SafeFetchError).message).toBe('Response exceeds 1 MiB');
      expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
      // The server stopped writing because the client hung up, not because it ran out of body.
      await vi.waitFor(() => expect(fixture.closes.get('/tiny-chunks')).toBe(1));
      expect(fixture.tinyBytesWritten).toBeLessThan(TINY_TOTAL_BYTES);
      expect(growthBytes).toBeLessThan(PEAK_GROWTH_LIMIT_BYTES);
    },
    CASE_TIMEOUT_MS,
  );
});
