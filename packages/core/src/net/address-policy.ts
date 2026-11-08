import { BlockList, isIP } from 'node:net';
import { SafeFetchError } from './safe-fetch-error.js';

/**
 * Which hosts a remote fetch may reach. The policy is applied twice: to the URL before any socket
 * opens (`assertRemoteUrl`) and to every address a hostname resolves to (`isBlockedAddress`), so a
 * name that points at this machine or the local network is refused exactly like the literal.
 */

/**
 * IPv4 ranges that are never a public registry: RFC 1122/1918/6598/3927/6890/2544/5771/1112, and
 * 168.63.129.16, the platform address that Azure virtual machines use for DNS and health probes.
 */
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['168.63.129.16', 32],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** IPv6: unspecified, loopback, unique-local, link-local and multicast (RFC 4291/4193). */
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

function buildBlockList(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of BLOCKED_IPV4_SUBNETS) {
    list.addSubnet(address, prefix, 'ipv4');
  }
  for (const [address, prefix] of BLOCKED_IPV6_SUBNETS) {
    list.addSubnet(address, prefix, 'ipv6');
  }
  return list;
}

const BLOCKED = buildBlockList();

const IPV6_GROUPS = 8;
const IPV6_GROUP_MAX = 0xffff;
const IPV4_OCTETS = 4;
const BYTE = 0xff;
const BITS_PER_BYTE = 8;

/** `a.b.c.d` as two 16-bit groups, or null when it is not a dotted quad. */
function dottedQuadToGroups(text: string): readonly number[] | null {
  const octets = text.split('.').map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (
    octets.length !== IPV4_OCTETS ||
    octets.some((octet) => Number.isNaN(octet) || octet > BYTE)
  ) {
    return null;
  }
  const [a, b, c, d] = octets as [number, number, number, number];
  return [(a << BITS_PER_BYTE) | b, (c << BITS_PER_BYTE) | d];
}

function hexGroups(text: string): readonly number[] | null {
  if (text === '') {
    return [];
  }
  const groups = text
    .split(':')
    .map((part) => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : NaN));
  return groups.some((group) => Number.isNaN(group) || group > IPV6_GROUP_MAX) ? null : groups;
}

/**
 * The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted IPv4 tail converted), or
 * null when the text is not one. `net.isIP` has already accepted the address; this only needs to
 * take it apart.
 */
export function parseIPv6Groups(address: string): readonly number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseSide = (side: string): readonly number[] | null => {
    const lastColon = side.lastIndexOf(':');
    const tail = side.slice(lastColon + 1);
    if (!tail.includes('.')) {
      return hexGroups(side);
    }
    const head = hexGroups(lastColon === -1 ? '' : side.slice(0, lastColon));
    const quad = dottedQuadToGroups(tail);
    return head === null || quad === null ? null : [...head, ...quad];
  };
  const left = parseSide(halves[0] ?? '');
  const right = halves.length === 2 ? parseSide(halves[1] ?? '') : [];
  if (left === null || right === null) {
    return null;
  }
  const missing = IPV6_GROUPS - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function groupsToDottedQuad(high: number, low: number): string {
  return `${high >> BITS_PER_BYTE}.${high & BYTE}.${low >> BITS_PER_BYTE}.${low & BYTE}`;
}

const SIX_TO_FOUR_PREFIX = 0x2002;
const NAT64_PREFIX: readonly number[] = [0x64, 0xff9b, 0, 0, 0, 0];
const MAPPED_PREFIX: readonly number[] = [0, 0, 0, 0, 0, 0xffff];
const COMPATIBLE_PREFIX: readonly number[] = [0, 0, 0, 0, 0, 0];

function startsWith(groups: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((group, index) => groups[index] === group);
}

/**
 * The IPv4 address an IPv6 address carries, if it is one of the transition forms: 6to4
 * `2002::/16` (RFC 3056, bits 16-47), NAT64 `64:ff9b::/96` (RFC 6052), IPv4-mapped `::ffff:0:0/96`
 * and the deprecated IPv4-compatible `::/96` (RFC 4291). `net.BlockList` handles only the mapped
 * form itself, so the others are checked through the address they embed.
 */
export function embeddedIPv4(groups: readonly number[]): string | undefined {
  const [g0, g1, g2, , , , g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === SIX_TO_FOUR_PREFIX) {
    return groupsToDottedQuad(g1, g2);
  }
  if (
    startsWith(groups, NAT64_PREFIX) ||
    startsWith(groups, MAPPED_PREFIX) ||
    startsWith(groups, COMPATIBLE_PREFIX)
  ) {
    return groupsToDottedQuad(g6, g7);
  }
  return undefined;
}

/**
 * True when `address` (an IPv4 or IPv6 literal, zone id allowed) must not be connected to:
 * loopback, private, link-local, carrier NAT, multicast, reserved, or an IPv6 transition address
 * that embeds such an IPv4. Anything that is not an IP address at all is also refused: this is the
 * last check before a socket, so it fails closed.
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 4) {
    return BLOCKED.check(bare, 'ipv4');
  }
  if (family !== 6) {
    return true;
  }
  if (BLOCKED.check(bare, 'ipv6')) {
    return true;
  }
  const groups = parseIPv6Groups(bare);
  if (groups === null) {
    return true;
  }
  const embedded = embeddedIPv4(groups);
  return embedded !== undefined && BLOCKED.check(embedded, 'ipv4');
}

export interface RemoteUrlOptions {
  /**
   * Hosts (names or IP literals, matched exactly and case-insensitively after normalisation) the
   * user vouches for: their addresses are not checked. HTTPS, no credentials, no redirects, the
   * deadlines and the byte cap still apply.
   */
  readonly allowPrivateHosts?: readonly string[];
}

const LOCALHOST = 'localhost';
const LOCALHOST_SUFFIX = `.${LOCALHOST}`;
const ALLOW_LIST_HINT = 'to allow it add the host to the allowPrivateHosts config key';

const DOT = '.';
const DOT_CHAR_CODE = 46;
const MULTIPLE_TRAILING_DOTS = 'URL host must not end in more than one dot';

/**
 * `text` without its trailing dots, but never shorter than one character: a host that is only dots
 * keeps one, so it is not mistaken for an empty host. One pass from the end. A pattern for this
 * backtracks quadratically on a long run of dots that does not end the string (100k dots took 10 s).
 */
function trimTrailingDots(text: string): string {
  let end = text.length;
  while (end > 1 && text.charCodeAt(end - 1) === DOT_CHAR_CODE) {
    end -= 1;
  }
  return text.slice(0, end);
}

function withoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * The form an allow-list entry is compared in: brackets off an IPv6 literal, lower-cased, trailing
 * dots removed. A URL's own host is read with {@link remoteHostOf}, which does not repair dots.
 */
export function normalizeHost(hostname: string): string {
  return trimTrailingDots(withoutBrackets(hostname).toLowerCase());
}

/**
 * The host a connection to `url` is made to, and the host every check judges: the hostname the URL
 * parser produced, with the brackets of an IPv6 literal off, in lower case and with ONE trailing
 * dot dropped (`example.com.` is the absolute form of `example.com`). The URL is parsed once and
 * this value is read from the result, never written back into a URL: the parser reads `127.1.` as
 * the address 127.0.0.1 but `127.1..` as a domain, and a host stripped of its dots and set again
 * would be read as that address after it had been judged as a name. More than one trailing dot is
 * no valid name and is refused instead of repaired.
 */
export function remoteHostOf(url: URL): string {
  const bare = withoutBrackets(url.hostname).toLowerCase();
  const host = bare.endsWith(DOT) ? bare.slice(0, -1) : bare;
  if (host === '') {
    throw new SafeFetchError('invalid_url', 'URL has no host');
  }
  if (host.endsWith(DOT)) {
    throw new SafeFetchError('invalid_url', MULTIPLE_TRAILING_DOTS);
  }
  return host;
}

export function isAllowListed(host: string, allowPrivateHosts: readonly string[] = []): boolean {
  return allowPrivateHosts.some((entry) => normalizeHost(entry) === host);
}

/** RFC 6761: `localhost` and every name under it are loopback by definition, whatever DNS says. */
function isLocalhostName(host: string): boolean {
  return host === LOCALHOST || host.endsWith(LOCALHOST_SUFFIX);
}

export function blockedHostError(host: string, resolvesTo: string): SafeFetchError {
  return new SafeFetchError(
    'blocked_host',
    `Blocked: private/internal URL "${host}" resolves to ${resolvesTo}; ${ALLOW_LIST_HINT}`,
  );
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new SafeFetchError('invalid_url', `Invalid URL "${url}"`);
  }
}

/**
 * Checks a URL before any socket opens and returns it as parsed: `https:` only, no username or
 * password, and a host that is neither a blocked IP literal nor a `localhost` name. The host judged
 * is {@link remoteHostOf} of the parsed URL, the very host the fetcher connects to, so a number
 * written as `0x7f.1`, `2130706433` or `[::FFFF:127.0.0.1]` is seen as the address it is, and a
 * host with more than one trailing dot is refused. A host on the allow-list skips the two host
 * checks. Throws {@link SafeFetchError} with `invalid_url` or `blocked_host`.
 */
export function assertRemoteUrl(url: string, options: RemoteUrlOptions = {}): URL {
  const parsed = parseUrl(url);
  if (parsed.protocol !== 'https:') {
    throw new SafeFetchError('invalid_url', 'Only HTTPS URLs are supported');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SafeFetchError('invalid_url', 'URL must not contain a username or password');
  }
  const host = remoteHostOf(parsed);
  if (isAllowListed(host, options.allowPrivateHosts)) {
    return parsed;
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    throw blockedHostError(host, host);
  }
  if (isLocalhostName(host)) {
    throw blockedHostError(host, 'the loopback interface (RFC 6761)');
  }
  return parsed;
}
