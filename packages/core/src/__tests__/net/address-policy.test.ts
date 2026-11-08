import { describe, expect, it, vi } from 'vitest';
import {
  assertRemoteUrl,
  embeddedIPv4,
  isBlockedAddress,
  normalizeHost,
  parseIPv6Groups,
  remoteHostOf,
} from '../../net/address-policy.js';
import { safeFetchText, SafeFetchError } from '../../net/safe-fetch.js';

/**
 * The URL policy runs before any socket: a refused literal must never reach the resolver, let
 * alone a listener. The lookup spy below is the proof that nothing was resolved.
 */

function refusal(url: string, allowPrivateHosts?: readonly string[]): SafeFetchError {
  try {
    assertRemoteUrl(url, { allowPrivateHosts });
  } catch (err) {
    if (err instanceof SafeFetchError) return err;
    throw err;
  }
  throw new Error(`${url} was accepted`);
}

describe('assertRemoteUrl refuses, before any lookup', () => {
  const BLOCKED_LITERALS: readonly [url: string, judgedAs: string][] = [
    ['https://[::]/', '::'],
    ['https://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['https://[::ffff:7f00:1]/', '::ffff:7f00:1'],
    ['https://0x7f.1/', '127.0.0.1'],
    ['https://2130706433/', '127.0.0.1'],
    ['https://127.1/', '127.0.0.1'],
    ['https://0/', '0.0.0.0'],
    ['https://100.100.100.200/', '100.100.100.200'],
    ['https://192.0.0.1/', '192.0.0.1'],
    ['https://198.18.0.1/', '198.18.0.1'],
    ['https://224.0.0.1/', '224.0.0.1'],
    ['https://255.255.255.255/', '255.255.255.255'],
    ['https://169.254.169.254/', '169.254.169.254'],
    ['https://[fd00:ec2::254]/', 'fd00:ec2::254'],
    ['https://[fe80::1]/', 'fe80::1'],
    ['https://[ff02::1]/', 'ff02::1'],
    ['https://[64:ff9b::7f00:1]/', '64:ff9b::7f00:1'],
    ['https://[2002:7f00:1::]/', '2002:7f00:1::'],
  ];

  it.each(BLOCKED_LITERALS)('%s is a blocked literal (%s)', (url, judgedAs) => {
    const err = refusal(url);
    expect(err.code).toBe('blocked_host');
    expect(err.message).toMatch(/^Blocked: private\/internal URL "/);
    expect(err.message).toContain(`"${judgedAs}"`);
    expect(err.message).toContain('allowPrivateHosts');
  });

  it.each([
    ['https://localhost./', 'localhost'],
    ['https://LOCALHOST/', 'localhost'],
    ['https://foo.localhost/', 'foo.localhost'],
  ])('%s is refused by name (RFC 6761)', (url, name) => {
    const err = refusal(url);
    expect(err.code).toBe('blocked_host');
    expect(err.message).toContain(`"${name}"`);
    expect(err.message).toContain('loopback');
  });

  // A name with SEVERAL trailing dots is refused outright. Stripping them and judging the rest
  // would leave a gap: `127.1..` is a domain to the URL parser, but a number once the dots are gone.
  it.each([
    'https://localhost../',
    'https://localhost.../',
    'https://LocalHost..../',
    'https://foo.localhost../',
    'https://a.b.localhost.../',
    'https://localhost%2e%2e/',
    'https://localhost\u3002\u3002/',
    'https://Registry.Example../x.json',
  ])('%s is refused outright however many trailing dots it has', (url) => {
    const err = refusal(url);
    expect(err.code).toBe('invalid_url');
    expect(err.message).toBe('URL host must not end in more than one dot');
  });

  it('a host that is only dots has no host', () => {
    for (const url of ['https://./', 'https://.:8443/']) {
      const err = refusal(url);
      expect(err.code).toBe('invalid_url');
      expect(err.message).toBe('URL has no host');
    }
    expect(refusal('https://../').message).toBe('URL host must not end in more than one dot');
  });

  it('never resolves a name with several trailing dots', async () => {
    const lookup = vi.fn();
    for (const url of ['https://localhost../', 'https://foo.localhost.../']) {
      await expect(safeFetchText(url, { lookup, headersTimeoutMs: 200 })).rejects.toMatchObject({
        code: 'invalid_url',
      });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['https://user:pw@example.com/', /username or password/],
    ['http://example.com/', /^Only HTTPS URLs are supported/],
    ['file:///etc/passwd', /^Only HTTPS URLs are supported/],
    ['https://exa mple.com/', /^Invalid URL/],
    ['not a url', /^Invalid URL/],
  ])('%s is an invalid URL', (url, message) => {
    const err = refusal(url);
    expect(err.code).toBe('invalid_url');
    expect(err.message).toMatch(message);
  });

  it('never calls the resolver for a refused URL', async () => {
    const lookup = vi.fn();
    for (const url of ['https://[::]/', 'https://127.1/', 'https://localhost./', 'http://x/']) {
      await expect(safeFetchText(url, { lookup })).rejects.toBeInstanceOf(SafeFetchError);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('assertRemoteUrl allows', () => {
  it('a public name, which is connected to as its normalised host', () => {
    const url = assertRemoteUrl('https://Registry.Example./x.json');
    expect(remoteHostOf(url)).toBe('registry.example');
    expect(url.pathname).toBe('/x.json');
  });

  it('a public IP literal', () => {
    expect(remoteHostOf(assertRemoteUrl('https://93.184.216.34/'))).toBe('93.184.216.34');
  });

  it('a public number in another spelling, as the dotted address it is', () => {
    expect(remoteHostOf(assertRemoteUrl('https://1572395042/'))).toBe('93.184.216.34');
    expect(remoteHostOf(assertRemoteUrl('https://0x5d.0xb8.0xd8.0x22./'))).toBe('93.184.216.34');
  });

  it('the allow-list does not rescue a name with several trailing dots', () => {
    expect(refusal('https://localhost../', ['localhost']).code).toBe('invalid_url');
    expect(refusal('https://127.1../', ['127.1', '127.0.0.1']).code).toBe('invalid_url');
  });

  it('an allow-list entry is matched however it is cased or dotted', () => {
    expect(
      remoteHostOf(assertRemoteUrl('https://localhost/', { allowPrivateHosts: ['LocalHost..'] })),
    ).toBe('localhost');
  });

  it('localhost only through the allow-list, matched case-insensitively', () => {
    expect(
      remoteHostOf(assertRemoteUrl('https://localhost/', { allowPrivateHosts: ['localhost'] })),
    ).toBe('localhost');
    expect(
      remoteHostOf(assertRemoteUrl('https://LOCALHOST./', { allowPrivateHosts: ['LocalHost'] })),
    ).toBe('localhost');
    expect(assertRemoteUrl('https://[::1]:8443/x', { allowPrivateHosts: ['[::1]'] }).host).toBe(
      '[::1]:8443',
    );
  });

  it('the allow-list does not relax the protocol or credential rules', () => {
    expect(refusal('http://localhost/', ['localhost']).code).toBe('invalid_url');
    expect(refusal('https://u:p@localhost/', ['localhost']).code).toBe('invalid_url');
  });

  it('the allow-list is per host: another private host stays refused', () => {
    expect(refusal('https://127.0.0.1/', ['localhost']).code).toBe('blocked_host');
  });
});

describe('isBlockedAddress boundaries', () => {
  it.each([
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['198.19.255.255', true],
    ['198.20.0.0', false],
    ['168.63.129.15', false],
    ['168.63.129.16', true],
    ['168.63.129.17', false],
    ['febf::1', true],
    ['fec0::1', false],
    ['::ffff:a9fe:a9fe', true],
    ['::ffff:5db8:d822', false],
    ['2001:db8::1', false],
    ['64:ff9b::5db8:d822', false],
    ['64:ff9b::a9fe:a9fe', true],
    ['2002:5db8:d822::', false],
    ['2002:c0a8:101::', true],
    ['::7f00:1', true],
    ['fe80::1%en0', true],
    ['not-an-address', true],
    ['', true],
  ])('%s -> %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});

describe('IPv6 helpers', () => {
  it('expands :: and a dotted tail', () => {
    expect(parseIPv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6Groups('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6Groups('2002:7f00:1::')).toEqual([0x2002, 0x7f00, 1, 0, 0, 0, 0, 0]);
    expect(parseIPv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects malformed text', () => {
    expect(parseIPv6Groups('1::2::3')).toBeNull();
    expect(parseIPv6Groups('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIPv6Groups('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6Groups('::ffff:300.0.0.1')).toBeNull();
    expect(parseIPv6Groups('g::1')).toBeNull();
  });

  it('extracts the embedded IPv4 of the transition forms only', () => {
    expect(embeddedIPv4([0x64, 0xff9b, 0, 0, 0, 0, 0x7f00, 1])).toBe('127.0.0.1');
    expect(embeddedIPv4([0x2002, 0xc0a8, 0x0101, 0, 0, 0, 0, 0])).toBe('192.168.1.1');
    expect(embeddedIPv4([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe])).toBe('169.254.169.254');
    expect(embeddedIPv4([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBeUndefined();
  });

  it('normalises hosts the way every comparison expects', () => {
    expect(normalizeHost('[::FFFF:7F00:1]')).toBe('::ffff:7f00:1');
    expect(normalizeHost('Example.COM.')).toBe('example.com');
    expect(normalizeHost('Example.COM....')).toBe('example.com');
    expect(normalizeHost('localhost..')).toBe('localhost');
    expect(normalizeHost('.')).toBe('.');
    expect(normalizeHost('..')).toBe('.');
  });
});
