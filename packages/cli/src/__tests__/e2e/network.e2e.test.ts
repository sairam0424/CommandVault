import { writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  context,
  createSandbox,
  expectNoDispatchFailure,
  writeConfigFile,
  type RunResult,
  type Sandbox,
} from './harness.js';
import {
  generateTlsFixture,
  startFixtureServer,
  type FixtureServer,
  type TlsFixture,
} from './tls-fixture.js';

/**
 * The network contract of the built CLI (RC-CLI-01/02, SEC-04/06): a URL that points at this
 * machine never produces a connection, the allow-list is the only way in, and a hostile server
 * (endless body, redirect, silence) ends in a clean error within the deadlines.
 *
 * Every run here is `runAsync`: the listeners and the TLS fixture live in this process, and a
 * synchronous spawn would freeze them for as long as the CLI waits on them.
 */

const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const MIB = 1024 * 1024;
/** Every case spawns the built CLI at least once; on a loaded runner one spawn can take seconds. */
const CLI_CASE_TIMEOUT_MS = 30_000;

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

function expectFailure(result: RunResult, code: number, message: RegExp): void {
  expectNoDispatchFailure(result);
  expect(result.status, context(result)).toBe(code);
  expect(result.stderr, context(result)).toMatch(message);
}

describe(
  'built CLI: a URL pointing at this machine never produces a connection',
  { timeout: CLI_CASE_TIMEOUT_MS },
  () => {
    let box: Sandbox;
    let v4: Listener;
    let v6: Listener;

    beforeAll(async () => {
      box = createSandbox();
      v4 = await listen('127.0.0.1');
      v6 = await listen('::');
    });

    afterAll(async () => {
      await Promise.all([closeServer(v4.server), closeServer(v6.server)]);
      box.dispose();
    });

    it('sync refuses the unspecified, the mapped-loopback and the trailing-dot localhost forms', async () => {
      const cases: readonly [args: readonly string[], message: RegExp][] = [
        [
          ['sync', `https://[::]:${v6.port}/x`, '--dry-run'],
          /^error: Blocked: private\/internal URL "::"/m,
        ],
        [
          ['sync', `https://[::ffff:127.0.0.1]:${v4.port}/x`, '--dry-run'],
          /^error: Blocked: private\/internal URL "::ffff:7f00:1"/m,
        ],
        [
          ['sync', `https://localhost.:${v4.port}/x`, '--dry-run'],
          /^error: Blocked: private\/internal URL "localhost" resolves to the loopback/m,
        ],
      ];
      for (const [args, message] of cases) {
        expectFailure(await box.runAsync(args), EXIT_RUNTIME, message);
      }
    });

    it('registry add refuses a loopback registry as a usage error and writes nothing', async () => {
      const result = await box.runAsync([
        'registry',
        'add',
        'lo',
        `https://127.0.0.1:${v4.port}/r.json`,
      ]);
      expectFailure(result, EXIT_USAGE, /^error: Blocked: private\/internal URL "127\.0\.0\.1"/m);
      expect((await box.runAsync(['registry', 'list'])).stdout).toMatch(/No registries configured/);
    });

    it('sync refuses a plain http URL at the usage layer', async () => {
      expectFailure(
        await box.runAsync(['sync', 'http://example.com/x', '--dry-run']),
        EXIT_USAGE,
        /^error: URL must start with https:\/\//m,
      );
    });

    it('import refuses a loopback URL the way sync does, and names the key that would allow it', async () => {
      expectFailure(
        await box.runAsync(['import', `https://127.0.0.1:${v4.port}/x`, '--dry-run']),
        EXIT_RUNTIME,
        /^error: no valid entries found in source \(Blocked: private\/internal URL "127\.0\.0\.1".*allowPrivateHosts config key\)/m,
      );
    });

    // To the URL parser `2130706433..` is a domain (its last label is empty), but once the dots are
    // stripped and the host is set again it is the number 2130706433, that is 127.0.0.1. Every
    // spelling below used to reach a loopback, private or link-local address through this path.
    const NUMERIC_HOSTS_WITH_TRAILING_DOTS: readonly string[] = [
      '2130706433..',
      '127.1..',
      '0x7f.1..',
      '0x7f000001...',
      '0177.0.0.1..',
      '10.1...',
      '192.168.1..',
      '100.64.1..',
    ];
    const MORE_THAN_ONE_DOT = 'URL validation failed: URL host must not end in more than one dot';

    it('sync refuses a numeric host with several trailing dots, as a URL error', async () => {
      const runs = await Promise.all(
        NUMERIC_HOSTS_WITH_TRAILING_DOTS.map((host) =>
          box.runAsync(['sync', `https://${host}:${v4.port}/ok`, '--dry-run']),
        ),
      );
      for (const result of runs) {
        expectFailure(result, EXIT_RUNTIME, new RegExp(`^error: ${MORE_THAN_ONE_DOT}$`, 'm'));
      }
    });

    it('import refuses a numeric host with several trailing dots the way sync does', async () => {
      const runs = await Promise.all(
        NUMERIC_HOSTS_WITH_TRAILING_DOTS.map((host) =>
          box.runAsync(['import', `https://${host}:${v4.port}/ok`, '--dry-run']),
        ),
      );
      for (const result of runs) {
        expectFailure(
          result,
          EXIT_RUNTIME,
          new RegExp(`^error: no valid entries found in source \\(${MORE_THAN_ONE_DOT}\\)$`, 'm'),
        );
      }
    });

    it('sync and import judge a numeric host with ONE trailing dot as the address it is', async () => {
      for (const command of ['sync', 'import']) {
        const result = await box.runAsync([command, `https://127.1.:${v4.port}/ok`, '--dry-run']);
        expectFailure(result, EXIT_RUNTIME, /Blocked: private\/internal URL "127\.0\.0\.1"/);
      }
    });

    it('neither listener accepted a single connection', () => {
      expect(v4.connections).toBe(0);
      expect(v6.connections).toBe(0);
    });
  },
);

describe(
  'built CLI: an allow-listed TLS registry, with the fixture certificate trusted',
  { timeout: CLI_CASE_TIMEOUT_MS },
  () => {
    let box: Sandbox;
    let tls: TlsFixture;
    let fixture: FixtureServer;
    let env: Readonly<Record<string, string>>;

    const url = (path: string): string => `https://localhost:${fixture.port}${path}`;

    beforeAll(async () => {
      tls = generateTlsFixture();
      fixture = await startFixtureServer(tls);
      box = createSandbox();
      writeConfigFile(box, { allowPrivateHosts: ['localhost'] });
      env = { NODE_EXTRA_CA_CERTS: tls.certPath };
    });

    afterAll(async () => {
      await fixture.close();
      tls.dispose();
      box.dispose();
    });

    it('sync --dry-run fetches a bundle and reports its entries', async () => {
      const result = await box.runAsync(['sync', url('/ok.json'), '--dry-run'], env);
      expectNoDispatchFailure(result);
      expect(result.status, context(result)).toBe(0);
      // The spinner's success line is on stderr, the entry listing on stdout.
      expect(`${result.stdout}${result.stderr}`, context(result)).toMatch(/Fetched 1 entries/);
      expect(result.stdout, context(result)).toContain('remote-skill');
      expect(fixture.servernames.at(-1)).toBe('localhost');
    });

    it('import --dry-run reaches the same allow-listed host, as the error message promises', async () => {
      const before = fixture.requests.length;
      const result = await box.runAsync(['import', url('/ok.json'), '--dry-run'], env);
      expectNoDispatchFailure(result);
      expect(result.status, context(result)).toBe(0);
      expect(`${result.stdout}${result.stderr}`, context(result)).toMatch(
        /Found 1 entries to import/,
      );
      expect(result.stdout, context(result)).toContain('remote-skill');
      expect(fixture.requests.slice(before)).toHaveLength(1);
    });

    it('sync reads a bundle that starts with a UTF-8 byte order mark', async () => {
      const result = await box.runAsync(['sync', url('/bom.json'), '--dry-run'], env);
      expectNoDispatchFailure(result);
      expect(result.status, context(result)).toBe(0);
      expect(`${result.stdout}${result.stderr}`, context(result)).toMatch(/Fetched 1 entries/);
      expect(result.stderr, context(result)).not.toMatch(/not valid JSON/);
    });

    it('a 200 MiB chunked body is cut at 10 MiB, quickly', async () => {
      const started = Date.now();
      const result = await box.runAsync(['sync', url('/big'), '--dry-run'], env);
      expectFailure(result, EXIT_RUNTIME, /^error: Response exceeds 10 MiB/m);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(fixture.bigBytesWritten).toBeLessThan(64 * MIB);
    });

    it('a redirect is refused, not followed', async () => {
      const before = fixture.requests.length;
      const result = await box.runAsync(['sync', url('/redirect'), '--dry-run'], env);
      expectFailure(result, EXIT_RUNTIME, /^error: redirect refused \(HTTP 302\)/m);
      expect(fixture.requests.slice(before)).toHaveLength(1);
    });

    it('a server that sends headers and then nothing is cut by the 15 s idle deadline', async () => {
      const started = Date.now();
      const result = await box.runAsync(['sync', url('/stall'), '--dry-run'], env);
      const elapsed = Date.now() - started;
      expectFailure(result, EXIT_RUNTIME, /^error: Request timed out \(no data for 15 s\)/m);
      expect(elapsed).toBeGreaterThanOrEqual(15_000);
      expect(elapsed).toBeLessThan(25_000);
    }, 40_000);

    it('registry add + search finds an entry served over TLS', async () => {
      const added = await box.runAsync(['registry', 'add', 'r', url('/registry.json')], env);
      expect(added.status, context(added)).toBe(0);
      const found = await box.runAsync(['registry', 'search', 'x'], env);
      expectNoDispatchFailure(found);
      expect(found.status, context(found)).toBe(0);
      expect(found.stdout, context(found)).toContain('x-tool');
      expect(found.stderr, context(found)).toBe('');
    });

    it('a registry that never answers is reported by name and exits 1', async () => {
      expect((await box.runAsync(['registry', 'remove', 'r'], env)).status).toBe(0);
      expect((await box.runAsync(['registry', 'add', 'n', url('/never')], env)).status).toBe(0);
      const result = await box.runAsync(['registry', 'search', 'x'], env);
      expectFailure(
        result,
        EXIT_RUNTIME,
        /^error: registry "n": no response headers within 15 s$/m,
      );
      expect(result.stdout, context(result)).not.toMatch(/No results/);
    }, 40_000);

    it('a registry that answers 101 Switching Protocols is reported by name, not hung', async () => {
      await box.runAsync(['registry', 'remove', 'n'], env);
      expect((await box.runAsync(['registry', 'add', 'u', url('/upgrade')], env)).status).toBe(0);
      const result = await box.runAsync(['registry', 'search', 'x'], env);
      expectFailure(
        result,
        EXIT_RUNTIME,
        /^error: registry "u": Connection to "localhost" closed without a response$/m,
      );
      expect(result.stderr, context(result)).not.toMatch(/input ended/);
    });
  },
);

describe(
  'built CLI: import reads config.json for a URL only',
  { timeout: CLI_CASE_TIMEOUT_MS },
  () => {
    let box: Sandbox;

    beforeAll(() => {
      box = createSandbox();
      writeConfigFile(box, '{bad');
    });

    afterAll(() => {
      box.dispose();
    });

    it('a URL import stops on a malformed config, before any connection', async () => {
      const result = await box.runAsync(['import', 'https://registry.example/b.json', '--dry-run']);
      expectFailure(result, EXIT_RUNTIME, /^error: malformed config file .*config\.json/m);
    });

    it('a file import does not need the config at all', async () => {
      const file = join(box.workDir, 'bundle.vault.json');
      writeFileSync(
        file,
        JSON.stringify({
          version: '1',
          source: 'e2e',
          entries: [{ name: 'local-one', type: 'skill', description: 'from a file' }],
        }),
      );
      const result = await box.runAsync(['import', file, '--dry-run']);
      expectNoDispatchFailure(result);
      expect(result.status, context(result)).toBe(0);
      expect(result.stdout, context(result)).toContain('local-one');
    });
  },
);
