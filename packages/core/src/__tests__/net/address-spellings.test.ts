import { createServer, isIP, type AddressInfo, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertRemoteUrl,
  isBlockedAddress,
  normalizeHost,
  remoteHostOf,
} from '../../net/address-policy.js';
import {
  resolveVetted,
  safeFetchText,
  SafeFetchError,
  type LookupAll,
} from '../../net/safe-fetch.js';

/**
 * No spelling of a blocked host may reach a socket. The URL is parsed once, the host that results
 * is the one that is judged, and the same host is the one that is connected to, so a number
 * written as decimal, octal, hex, a short form, an IPv4-mapped IPv6 literal or with trailing dots
 * is judged as the address it is. Every table below is a spelling class, not a single example.
 */

const REFUSAL_CODES: ReadonlySet<string> = new Set(['blocked_host', 'invalid_url']);

/** The error `assertRemoteUrl` refuses `url` with, or undefined when it lets the URL through. */
function refusalOf(url: string): SafeFetchError | undefined {
  try {
    assertRemoteUrl(url);
    return undefined;
  } catch (err) {
    if (err instanceof SafeFetchError && REFUSAL_CODES.has(err.code)) return err;
    throw err;
  }
}

/** Hosts that are, once parsed, an address in a blocked range or the name `localhost`. */
const BLOCKED_HOSTS: readonly string[] = [
  // Loopback, spelled as dotted, short, decimal, hex, octal and mixed numbers; the last one is
  // written with ideographic full stops, which the URL parser maps to ASCII dots.
  '127.0.0.1',
  '127.1',
  '127.0.1',
  '2130706433',
  '0x7f.1',
  '0x7f000001',
  '0X7F.0.0.1',
  '0177.0.0.1',
  '0177.1',
  '017700000001',
  '0x7f.0x0.0x0.0x1',
  '127.000.000.001',
  '127。0。0。1',
  // "This host" and the unspecified address.
  '0',
  '0.0.0.0',
  '0x0',
  '00',
  // RFC 1918, carrier-grade NAT, link-local (the cloud metadata address), benchmarking, multicast
  // and reserved ranges.
  '10.0.0.1',
  '10.1',
  '167772161',
  '012.1',
  '172.16.0.1',
  '172.31.255.255',
  '0xac.0x10.0.1',
  '192.168.0.1',
  '192.168.1',
  '3232235521',
  '100.64.0.1',
  '100.64.1',
  '100.127.255.255',
  '169.254.169.254',
  '2852039166',
  '0xa9fea9fe',
  '198.18.0.1',
  '224.0.0.1',
  '240.0.0.1',
  '255.255.255.255',
  '4294967295',
  // IPv6 literals: loopback, unspecified, mapped and compatible IPv4, unique-local, link-local,
  // multicast, NAT64 and 6to4 forms, in short, long and upper-case spellings.
  '[::1]',
  '[::]',
  '[0:0:0:0:0:0:0:1]',
  '[0000:0000:0000:0000:0000:0000:0000:0001]',
  '[::FFFF:7F00:1]',
  '[::ffff:127.0.0.1]',
  '[::ffff:10.0.0.1]',
  '[::127.0.0.1]',
  '[fe80::1]',
  '[fc00::1]',
  '[fd00:ec2::254]',
  '[ff02::1]',
  '[64:ff9b::7f00:1]',
  '[2002:7f00:1::]',
  // Names that are loopback by definition (RFC 6761), in any letter case.
  'localhost',
  'LOCALHOST',
  'LocalHost',
  'foo.localhost',
  'a.b.localhost',
];

/** Written after a host: none, one to three dots, percent-encoded and Unicode dots, a mixture. */
const DOT_SUFFIXES: readonly string[] = [
  '',
  '.',
  '..',
  '...',
  '%2e',
  '%2e%2e',
  '。',
  '．',
  '｡',
  '.%2E.',
];

/** The URL around a host: plain, with a port, a path and a query, userinfo, upper-case scheme. */
const WRAPPERS: ReadonlyArray<(host: string) => string> = [
  (host) => `https://${host}/`,
  (host) => `https://${host}:8443/registry.json?x=1#top`,
  (host) => `https://user@${host}/`,
  (host) => `https://user:secret@${host}:8443/`,
  (host) => `HTTPS://${host}/`,
];

const LETTER_CASES: ReadonlyArray<(text: string) => string> = [
  (text) => text,
  (text) => text.toUpperCase(),
];

function* wrappedUrls(hosts: readonly string[], suffixes: readonly string[]): Generator<string> {
  for (const host of hosts) {
    for (const suffix of suffixes) {
      for (const wrap of WRAPPERS) {
        for (const changeCase of LETTER_CASES) {
          yield wrap(changeCase(`${host}${suffix}`));
        }
      }
    }
  }
}

function allowedAmong(urls: Iterable<string>): {
  readonly total: number;
  readonly allowed: string[];
} {
  let total = 0;
  const allowed: string[] = [];
  for (const url of urls) {
    total += 1;
    if (refusalOf(url) === undefined) allowed.push(url);
  }
  return { total, allowed };
}

describe('assertRemoteUrl: no spelling of a blocked host gets through', () => {
  it('refuses every host x trailing dots x port/userinfo x letter case', () => {
    const { total, allowed } = allowedAmong(wrappedUrls(BLOCKED_HOSTS, DOT_SUFFIXES));
    expect(total).toBe(BLOCKED_HOSTS.length * DOT_SUFFIXES.length * WRAPPERS.length * 2);
    // On failure the list of URLs that were let through is the message.
    expect(allowed).toEqual([]);
  });

  it.each([
    'https://2130706433../',
    'https://127.1../',
    'https://0x7f.1../',
    'https://10.1../',
    'https://2130706433.../',
    'https://0x7f000001../',
    'https://0177.0.0.1../',
    'https://192.168.1../',
    'https://100.64.1../',
    'https://0../',
    'https://2130706433..:8443/ok',
    'https://127.1..:8443/ok',
  ])('%s is refused outright, not stripped and judged', (url) => {
    const err = refusalOf(url);
    expect(err?.code).toBe('invalid_url');
    expect(err?.message).toBe('URL host must not end in more than one dot');
  });

  it.each([
    'https://2130706433./',
    'https://127.1./',
    'https://0x7f.1./',
    'https://10.1./',
    'https://127.1%2e/',
    'https://127.1。/',
  ])('%s (one trailing dot) is judged as the address it is', (url) => {
    const err = refusalOf(url);
    expect(err?.code).toBe('blocked_host');
    expect(err?.message).toMatch(/^Blocked: private\/internal URL "(127\.0\.0\.1|10\.0\.0\.1)"/);
  });
});

/** `a.b.c.d` in the nine ways a URL host can write an IPv4 address. */
function ipv4Spellings(address: string): readonly string[] {
  const [a, b, c, d] = address.split('.').map(Number) as [number, number, number, number];
  const whole = ((a * 256 + b) * 256 + c) * 256 + d;
  const hex = (value: number): string => `0x${value.toString(16)}`;
  const octal = (value: number): string => `0${value.toString(8)}`;
  return [
    `${a}.${b}.${c}.${d}`,
    `${a}.${b}.${c * 256 + d}`,
    `${a}.${(b * 256 + c) * 256 + d}`,
    `${whole}`,
    `${hex(a)}.${hex(b)}.${hex(c)}.${hex(d)}`,
    `${hex(a)}.${(b * 256 + c) * 256 + d}`,
    hex(whole),
    `${octal(a)}.${octal(b)}.${octal(c)}.${octal(d)}`,
    octal(whole),
  ];
}

const BLOCKED_ADDRESSES: readonly string[] = [
  '127.0.0.1',
  '127.255.255.254',
  '10.0.0.1',
  '10.255.0.3',
  '172.16.0.1',
  '172.31.1.1',
  '192.168.0.1',
  '192.168.254.1',
  '100.64.0.1',
  '100.127.0.9',
  '169.254.169.254',
  '0.0.0.0',
  '0.1.2.3',
  '198.18.0.1',
  '198.19.1.1',
  '192.0.0.8',
  '224.0.0.1',
  '239.1.1.1',
  '240.0.0.1',
  '255.255.255.255',
];

const PUBLIC_ADDRESSES: readonly string[] = [
  '93.184.216.34',
  '8.8.8.8',
  '1.1.1.1',
  '100.63.255.255',
  '172.32.0.1',
  '192.169.0.1',
  '11.0.0.1',
  '126.255.255.255',
  '128.0.0.1',
];

describe('assertRemoteUrl: every way to write an IPv4 address is judged as that address', () => {
  const REFUSED_SUFFIXES = ['', '.', '..', '...', '%2e', '%2e%2e', '。。', '.。'];

  it('refuses each blocked address in all nine spellings, with and without trailing dots', () => {
    const urls = BLOCKED_ADDRESSES.flatMap((address) =>
      ipv4Spellings(address).flatMap((spelling) =>
        REFUSED_SUFFIXES.map((suffix) => `https://${spelling}${suffix}:8443/x`),
      ),
    );
    const { total, allowed } = allowedAmong(urls);
    expect(total).toBe(BLOCKED_ADDRESSES.length * 9 * REFUSED_SUFFIXES.length);
    expect(allowed).toEqual([]);
  });

  it('lets a public address through under every spelling, judged and connected as dotted decimal', () => {
    for (const address of PUBLIC_ADDRESSES) {
      for (const spelling of ipv4Spellings(address)) {
        for (const suffix of ['', '.', '%2e', '。']) {
          const url = assertRemoteUrl(`https://${spelling}${suffix}/x`);
          expect(remoteHostOf(url), `${spelling}${suffix}`).toBe(address);
        }
      }
    }
  });

  it('refuses a public address written with more than one trailing dot, like any other host', () => {
    for (const address of PUBLIC_ADDRESSES) {
      for (const spelling of ipv4Spellings(address)) {
        for (const suffix of ['..', '...', '%2e%2e']) {
          expect(refusalOf(`https://${spelling}${suffix}/x`)?.code, `${spelling}${suffix}`).toBe(
            'invalid_url',
          );
        }
      }
    }
  });

  it('invariant: whatever is let through is not a blocked address at the host that is connected to', () => {
    const urls = [...BLOCKED_ADDRESSES, ...PUBLIC_ADDRESSES].flatMap((address) =>
      ipv4Spellings(address).flatMap((spelling) =>
        [...REFUSED_SUFFIXES, '..'].map((suffix) => `https://${spelling}${suffix}/`),
      ),
    );
    const violations: string[] = [];
    for (const candidate of urls) {
      if (refusalOf(candidate) !== undefined) continue;
      const host = remoteHostOf(new URL(candidate));
      if (isIP(host) !== 0 && isBlockedAddress(host)) violations.push(candidate);
    }
    expect(violations).toEqual([]);
  });
});

describe('remoteHostOf is the one host that is judged and connected to', () => {
  it('drops the brackets of an IPv6 literal and one trailing dot, in lower case', () => {
    expect(remoteHostOf(new URL('https://[::FFFF:7F00:1]/'))).toBe('::ffff:7f00:1');
    expect(remoteHostOf(new URL('https://Registry.Example./x'))).toBe('registry.example');
    expect(remoteHostOf(new URL('https://Registry.Example/x'))).toBe('registry.example');
  });

  it('refuses a host with more than one trailing dot, or none', () => {
    for (const text of ['https://a../', 'https://a.b.../', 'https://../', 'https://a%2e%2e/']) {
      expect(() => remoteHostOf(new URL(text)), text).toThrowError(
        expect.objectContaining({
          code: 'invalid_url',
          message: 'URL host must not end in more than one dot',
        }),
      );
    }
    expect(() => remoteHostOf(new URL('https://./'))).toThrowError(
      expect.objectContaining({ code: 'invalid_url', message: 'URL has no host' }),
    );
  });

  it('is what the returned URL is judged by, so the check and the connection cannot disagree', () => {
    const url = assertRemoteUrl('https://0x7f.1.:8443/x', {
      allowPrivateHosts: ['127.0.0.1'],
    });
    expect(url.href).toBe('https://127.0.0.1:8443/x');
    expect(remoteHostOf(url)).toBe('127.0.0.1');
  });
});

describe('the trailing-dot handling is linear', () => {
  const DOTS = 100_000;
  // The quadratic regular expression took 10 s here; a linear scan takes well under a millisecond.
  const BOUND_MS = 2_000;

  function elapsedMs(work: () => void): number {
    const started = performance.now();
    work();
    return performance.now() - started;
  }

  it('normalizeHost on a long run of dots that is not at the end', () => {
    const host = `a${'.'.repeat(DOTS)}b`;
    expect(elapsedMs(() => normalizeHost(host))).toBeLessThan(BOUND_MS);
    expect(normalizeHost(host)).toBe(host);
  });

  it('normalizeHost on a long run of dots at the end, and on only dots', () => {
    expect(elapsedMs(() => normalizeHost(`a${'.'.repeat(DOTS)}`))).toBeLessThan(BOUND_MS);
    expect(normalizeHost(`A${'.'.repeat(DOTS)}`)).toBe('a');
    expect(normalizeHost('.'.repeat(DOTS))).toBe('.');
  });

  it('assertRemoteUrl on a long run of dots inside, at the end and at the start of a host', () => {
    for (const url of [
      `https://a${'.'.repeat(DOTS)}b/`,
      `https://a${'.'.repeat(DOTS)}/`,
      `https://${'.'.repeat(DOTS)}a/`,
    ]) {
      expect(elapsedMs(() => refusalOf(url))).toBeLessThan(BOUND_MS);
    }
  });
});

/** A listener that counts the connections it is given and drops them at once. */
interface Listener {
  readonly server: Server;
  port: number;
  connections: number;
}

function listen(host: string): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const listener: Listener = { server: createServer(), port: 0, connections: 0 };
    listener.server.on('connection', (socket) => {
      listener.connections += 1;
      socket.destroy();
    });
    listener.server.once('error', reject);
    listener.server.listen({ host, port: 0, ipv6Only: false }, () => {
      listener.port = (listener.server.address() as AddressInfo).port;
      resolve(listener);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('safeFetchText: no spelling of a loopback host produces a connection', () => {
  const lookup = vi.fn<LookupAll>((_hostname, _options, callback) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });
  let v4: Listener;
  let v6: Listener;

  beforeAll(async () => {
    v4 = await listen('127.0.0.1');
    v6 = await listen('::');
  });

  afterAll(async () => {
    await Promise.all([closeServer(v4.server), closeServer(v6.server)]);
  });

  async function codeOf(url: string): Promise<string> {
    try {
      await safeFetchText(url, { lookup, headersTimeoutMs: 2_000 });
    } catch (err) {
      if (err instanceof SafeFetchError) return err.code;
      throw err;
    }
    return 'fetched';
  }

  const NUMERIC_HOSTS = [
    '2130706433',
    '127.1',
    '127.0.1',
    '0x7f.1',
    '0x7f000001',
    '0177.0.0.1',
    '017700000001',
    '10.1',
    '192.168.1',
    '100.64.1',
    '169.254.169.254',
    '0',
  ];

  it('refuses a numeric host with none, one, two or three trailing dots before any lookup', async () => {
    for (const host of NUMERIC_HOSTS) {
      for (const dots of ['', '.', '..', '...']) {
        const code = await codeOf(`https://${host}${dots}:${v4.port}/ok`);
        expect(REFUSAL_CODES.has(code), `${host}${dots} -> ${code}`).toBe(true);
      }
    }
  });

  it('refuses IPv6 literals in every spelling, mapped IPv4 included', async () => {
    for (const host of [
      '[::1]',
      '[0:0:0:0:0:0:0:1]',
      '[::ffff:7f00:1]',
      '[::FFFF:7F00:1]',
      '[::ffff:127.0.0.1]',
      '[::127.0.0.1]',
      '[64:ff9b::7f00:1]',
      '[2002:7f00:1::]',
    ]) {
      const code = await codeOf(`https://${host}:${v6.port}/ok`);
      expect(REFUSAL_CODES.has(code), `${host} -> ${code}`).toBe(true);
    }
  });

  it('refuses localhost with one to three trailing dots in any letter case', async () => {
    for (const host of ['localhost', 'LOCALHOST', 'foo.Localhost']) {
      for (const dots of ['.', '..', '...']) {
        const code = await codeOf(`https://${host}${dots}:${v4.port}/ok`);
        expect(REFUSAL_CODES.has(code), `${host}${dots} -> ${code}`).toBe(true);
      }
    }
  });

  it('neither the resolver nor either listener was ever reached', () => {
    expect(lookup).not.toHaveBeenCalled();
    expect(v4.connections).toBe(0);
    expect(v6.connections).toBe(0);
  });
});

describe('resolveVetted applies the address policy to IP literals as well', () => {
  const resolver = vi.fn<LookupAll>();

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:7f00:1',
    'fe80::1',
    '64:ff9b::7f00:1',
  ])('refuses the literal %s without resolving anything', async (literal) => {
    await expect(resolveVetted(literal, { lookup: resolver })).rejects.toMatchObject({
      code: 'blocked_host',
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('lets a public literal through as the single address to pin', async () => {
    await expect(resolveVetted('93.184.216.34', { lookup: resolver })).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    await expect(resolveVetted('2606:4700::1111', { lookup: resolver })).resolves.toEqual([
      { address: '2606:4700::1111', family: 6 },
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('lets an allow-listed private literal through, and only that one', async () => {
    const allowPrivateHosts = ['127.0.0.1', '::1'];
    await expect(resolveVetted('127.0.0.1', { allowPrivateHosts })).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(resolveVetted('::1', { allowPrivateHosts })).resolves.toEqual([
      { address: '::1', family: 6 },
    ]);
    await expect(resolveVetted('10.0.0.1', { allowPrivateHosts })).rejects.toMatchObject({
      code: 'blocked_host',
    });
  });
});
