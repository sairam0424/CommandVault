import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeFetchText, SafeFetchError, type LookupAll } from '../../net/safe-fetch.js';

/**
 * RC-CLI-01 reproduced: a name that resolves to this machine must never produce a connection.
 * Two plain listeners count accepted connections; every refused fetch below must leave both at 0.
 * The listeners close each connection at once, so an allowed fetch fails fast at the TLS layer.
 */

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
      // The same object the connection handler counts on, not a copy.
      listener.port = (listener.server.address() as AddressInfo).port;
      resolve(listener);
    });
  });
}

const PUBLIC_ADDRESS = '93.184.216.34';
/** Without the deadline the silent-resolver case never settles; fail it well before 30 s. */
const SILENT_RESOLVER_TIMEOUT_MS = 5_000;

const ANSWERS: Readonly<Record<string, readonly string[]>> = {
  'loop.test': ['127.0.0.1'],
  'v6loop.test': ['::1'],
  'mixed.test': [PUBLIC_ADDRESS, '127.0.0.1'],
  'nat64.test': ['64:ff9b::7f00:1'],
};

const lookup = vi.fn<LookupAll>((hostname, _options, callback) => {
  const answers = ANSWERS[hostname];
  if (answers === undefined) {
    const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    error.code = 'ENOTFOUND';
    callback(error, []);
    return;
  }
  callback(
    null,
    answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
});

async function refusal(
  url: string,
  allowPrivateHosts?: readonly string[],
): Promise<SafeFetchError> {
  try {
    await safeFetchText(url, { lookup, allowPrivateHosts, headersTimeoutMs: 2_000 });
  } catch (err) {
    if (err instanceof SafeFetchError) return err;
    throw err;
  }
  throw new Error(`${url} was fetched`);
}

describe('safeFetchText never connects to a private address', () => {
  let v4: Listener;
  let v6: Listener;

  beforeAll(async () => {
    v4 = await listen('127.0.0.1');
    v6 = await listen('::');
  });

  afterAll(async () => {
    await Promise.all([
      new Promise((resolve) => v4.server.close(resolve)),
      new Promise((resolve) => v6.server.close(resolve)),
    ]);
  });

  it.each([
    ['loop.test', '127.0.0.1'],
    ['v6loop.test', '::1'],
    ['mixed.test', '127.0.0.1'],
    ['nat64.test', '64:ff9b::7f00:1'],
  ])('a name resolving to %s is blocked_host naming the address', async (name, address) => {
    const port = name === 'v6loop.test' ? v6.port : v4.port;
    const err = await refusal(`https://${name}:${port}/x`);
    expect(err.code).toBe('blocked_host');
    expect(err.message).toBe(
      `Blocked: private/internal URL "${name}" resolves to ${address}; to allow it add the host to the allowPrivateHosts config key`,
    );
  });

  it('a literal is refused without any resolution', async () => {
    lookup.mockClear();
    const unspecified = await refusal(`https://[::]:${v6.port}/x`);
    const mapped = await refusal(`https://[::ffff:127.0.0.1]:${v4.port}/x`);
    expect(unspecified.code).toBe('blocked_host');
    expect(mapped.code).toBe('blocked_host');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a name that does not resolve is a dns failure, not a connection', async () => {
    const err = await refusal(`https://unknown.test:${v4.port}/x`);
    expect(err.code).toBe('dns');
    expect(err.message).toBe('Cannot resolve "unknown.test" (ENOTFOUND)');
  });

  it(
    'a resolver that never answers is cut by the headers deadline, which names the host',
    async () => {
      const silent: LookupAll = () => {};
      const started = Date.now();
      let err: SafeFetchError | undefined;
      try {
        await safeFetchText(`https://hang.test:${v4.port}/x`, {
          lookup: silent,
          headersTimeoutMs: 200,
        });
      } catch (caught) {
        err = caught as SafeFetchError;
      }
      expect(err?.code).toBe('headers_timeout');
      expect(err?.message).toBe('no response headers within 0.2 s (still resolving "hang.test")');
      expect(Date.now() - started).toBeLessThan(2_000);
    },
    SILENT_RESOLVER_TIMEOUT_MS,
  );

  it('neither listener accepted anything', () => {
    expect(v4.connections).toBe(0);
    expect(v6.connections).toBe(0);
  });

  it('the allow-list is the only way in: the listener then sees exactly one connection', async () => {
    const err = await refusal(`https://loop.test:${v4.port}/x`, ['loop.test']);
    expect(['tls', 'network']).toContain(err.code);
    expect(v4.connections).toBe(1);
    expect(v6.connections).toBe(0);
  });
});
