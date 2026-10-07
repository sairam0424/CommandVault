import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * A self-signed certificate for `registry.test` / `localhost` / 127.0.0.1 / ::1, generated at
 * test time with openssl (a committed PEM would trip the Gitleaks workflow), and an HTTPS server
 * whose routes exercise every failure the fetcher must survive: no headers, headers then silence,
 * a trickle, an endless body, a redirect, a 503, a compressed body, an unsolicited 101, a body
 * sent one byte per chunk, a body that stops after a trickle; and the success shapes it must read:
 * a UTF-8 byte order mark, a `Content-Encoding: Identity`, a body of an exact size, an echo of the
 * request headers.
 */

export interface TlsFixture {
  readonly dir: string;
  readonly keyPath: string;
  readonly certPath: string;
  readonly key: Buffer;
  readonly cert: Buffer;
  dispose(): void;
}

const OPENSSL_CANDIDATES: readonly string[] =
  process.platform === 'win32'
    ? ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']
    : ['openssl'];

export const FIXTURE_SERVERNAME = 'registry.test';

function runOpenssl(args: readonly string[]): void {
  const failures: string[] = [];
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      return;
    } catch (err) {
      failures.push(`${candidate}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(
    `openssl is required to generate the TLS test certificate and none worked:\n${failures.join('\n')}`,
  );
}

/** Generates a fresh key and certificate under a temp dir; throws when openssl is unavailable. */
export function generateTlsFixture(): TlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'cv-tls-fixture-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  runOpenssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '3650',
    '-subj',
    `/CN=${FIXTURE_SERVERNAME}`,
    '-addext',
    `subjectAltName=DNS:${FIXTURE_SERVERNAME},DNS:localhost,IP:127.0.0.1,IP:::1`,
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);
  return {
    dir,
    keyPath,
    certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface SeenRequest {
  readonly path: string;
  readonly host: string | undefined;
}

export interface FixtureServer {
  readonly server: Server;
  port: number;
  /** TCP connections accepted, handshake complete or not. */
  connections: number;
  /** SNI name of every COMPLETED TLS handshake, in order (`''` when the client sent none). */
  readonly servernames: string[];
  readonly requests: SeenRequest[];
  /** Sockets of requests that have closed, per route. */
  readonly closes: Record<string, number>;
  /** Bytes the `/big` route managed to write before the client went away. */
  bigBytesWritten: number;
  /** Body bytes (one per chunk) `/tiny-chunks` managed to write before the client went away. */
  tinyBytesWritten: number;
  /** When each byte of `/trickle-then-stall` was written (`Date.now()`), oldest first. */
  readonly trickleWrites: number[];
  close(): Promise<void>;
}

const JSON_TYPE = 'application/json';
const MIB = 1024 * 1024;
const BIG_TOTAL_BYTES = 200 * MIB;
const BIG_CHUNK = Buffer.alloc(MIB, 0x78);
const SLOW_INTERVAL_MS = 100;
/** Bytes `/trickle-then-stall` sends before it goes quiet. */
export const TRICKLE_WRITES = 8;
const HTTP_SWITCHING_PROTOCOLS = 101;
export const TINY_TOTAL_BYTES = 16 * MIB;
/** One-byte chunked frame: size line, the byte, CRLF. Every frame becomes its own `data` event. */
const TINY_FRAMES_PER_WRITE = 8192;
const TINY_BLOCK = Buffer.from('1\r\nx\r\n'.repeat(TINY_FRAMES_PER_WRITE));
const UTF8_BOM = '\uFEFF';

export const OK_BUNDLE = {
  version: '1.0',
  exportedAt: '2026-01-01T00:00:00.000Z',
  source: 'fixture',
  totalEntries: 1,
  entries: [
    {
      name: 'remote-skill',
      type: 'skill',
      source: 'community',
      description: 'A skill served by the TLS fixture',
      tags: ['fixture'],
      metadata: {},
      content: 'remote body',
    },
  ],
};

export const REGISTRY_ENTRIES = [
  { name: 'x-tool', description: 'finds x', type: 'skill', url: 'https://registry.test/x' },
];

function writeBig(res: ServerResponse, fixture: FixtureServer): void {
  const pump = (): void => {
    while (fixture.bigBytesWritten < BIG_TOTAL_BYTES && !res.destroyed) {
      fixture.bigBytesWritten += BIG_CHUNK.length;
      if (!res.write(BIG_CHUNK)) {
        res.once('drain', pump);
        return;
      }
    }
    if (!res.destroyed) res.end();
  };
  pump();
}

/**
 * A chunked response whose every chunk is ONE byte, framed by hand on the socket: Node's own
 * chunked writer would join the writes. The client sees one `data` event per byte.
 */
function writeTinyChunks(socket: Duplex, fixture: FixtureServer): void {
  socket.write(
    `HTTP/1.1 200 OK\r\ncontent-type: ${JSON_TYPE}\r\ntransfer-encoding: chunked\r\n\r\n`,
  );
  const pump = (): void => {
    while (fixture.tinyBytesWritten < TINY_TOTAL_BYTES && !socket.destroyed) {
      fixture.tinyBytesWritten += TINY_FRAMES_PER_WRITE;
      if (!socket.write(TINY_BLOCK)) {
        socket.once('drain', pump);
        return;
      }
    }
    if (!socket.destroyed) socket.end('0\r\n\r\n');
  };
  pump();
}

/**
 * A single-chunk response with the given Transfer-Encoding value, framed by hand on the socket:
 * Node's own writer only ever sends `chunked`.
 */
function writeTransferCoded(socket: Duplex, codings: string, payload: Buffer): void {
  socket.write(
    `HTTP/1.1 200 OK\r\ncontent-type: ${JSON_TYPE}\r\ntransfer-encoding: ${codings}\r\nconnection: close\r\n\r\n`,
  );
  socket.write(`${payload.length.toString(16)}\r\n`);
  socket.write(payload);
  socket.end('\r\n0\r\n\r\n');
}

const CHUNKED_ROUTE = /^\/chunked\/(\d+)$/;
const CHUNKED_PIECES = 3;

/** `total` bytes as a chunked response (no Content-Length) in several chunks. */
function writeChunkedBytes(res: ServerResponse, total: number): void {
  const piece = Math.floor(total / CHUNKED_PIECES);
  res.writeHead(200, { 'content-type': JSON_TYPE });
  for (let sent = 1; sent < CHUNKED_PIECES; sent += 1) {
    res.write('x'.repeat(piece));
  }
  res.end('x'.repeat(total - piece * (CHUNKED_PIECES - 1)));
}

function route(req: IncomingMessage, res: ServerResponse, fixture: FixtureServer): void {
  const path = req.url ?? '/';
  const chunked = CHUNKED_ROUTE.exec(path);
  if (chunked !== null) {
    writeChunkedBytes(res, Number(chunked[1]));
    return;
  }
  switch (path) {
    case '/ok.json':
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify(OK_BUNDLE));
      return;
    case '/bom.json':
      // A UTF-8 byte order mark before the JSON, as editors on Windows and some servers write it.
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(`${UTF8_BOM}${JSON.stringify(OK_BUNDLE)}`);
      return;
    case '/echo-request':
      // The request headers exactly as they arrived, for the tests that pin what the client sends.
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ headers: req.headers, rawHeaders: req.rawHeaders }));
      return;
    case '/identity-upper':
      // RFC 9110 5.8.2: content-codings are case-insensitive, so this is an uncompressed body.
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'Identity' });
      res.end(JSON.stringify(OK_BUNDLE));
      return;
    case '/gzip-upper':
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'GZIP' });
      res.end(gzipSync(JSON.stringify(OK_BUNDLE)));
      return;
    case '/te-gzip-chunked':
      // A gzip body under `Transfer-Encoding: gzip, chunked`: Node hands the client the gzip bytes.
      writeTransferCoded(req.socket, 'gzip, chunked', gzipSync(JSON.stringify(OK_BUNDLE)));
      return;
    case '/te-chunked-upper':
      // RFC 9110 7.7: transfer-codings are case-insensitive, so this is a plain chunked body.
      writeTransferCoded(req.socket, 'Chunked', Buffer.from(JSON.stringify(OK_BUNDLE)));
      return;
    case '/tiny-chunks':
      writeTinyChunks(req.socket, fixture);
      return;
    case '/registry.json':
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify(REGISTRY_ENTRIES));
      return;
    case '/never':
      return;
    case '/stall':
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.flushHeaders();
      return;
    case '/slow': {
      res.writeHead(200, { 'content-type': JSON_TYPE });
      const timer = setInterval(() => res.write('x'), SLOW_INTERVAL_MS);
      res.on('close', () => clearInterval(timer));
      return;
    }
    case '/trickle-then-stall': {
      // A few bytes spread over time, then silence with the connection left open.
      res.writeHead(200, { 'content-type': JSON_TYPE });
      let sent = 0;
      const timer = setInterval(() => {
        fixture.trickleWrites.push(Date.now());
        res.write('x');
        sent += 1;
        if (sent === TRICKLE_WRITES) clearInterval(timer);
      }, SLOW_INTERVAL_MS);
      res.on('close', () => clearInterval(timer));
      return;
    }
    case '/big':
      res.writeHead(200, { 'content-type': JSON_TYPE });
      writeBig(res, fixture);
      return;
    case '/redirect':
      res.writeHead(302, { location: `https://${FIXTURE_SERVERNAME}/elsewhere.json` });
      res.end('moved');
      return;
    case '/status/503':
      res.statusMessage = 'Service Unavailable';
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Service Unavailable');
      return;
    case '/gzip':
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify(OK_BUNDLE)));
      return;
    case '/upgrade':
      // An unsolicited 101: Node's client discards it and destroys the socket WITHOUT an error.
      res.writeHead(HTTP_SWITCHING_PROTOCOLS, { upgrade: 'websocket', connection: 'Upgrade' });
      res.flushHeaders();
      return;
    default:
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
  }
}

/** Starts the fixture server on 127.0.0.1 with the fixture's key and certificate. */
export function startFixtureServer(tls: TlsFixture): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = createServer({ key: tls.key, cert: tls.cert });
    const fixture: FixtureServer = {
      server,
      port: 0,
      connections: 0,
      servernames: [],
      requests: [],
      closes: {},
      bigBytesWritten: 0,
      tinyBytesWritten: 0,
      trickleWrites: [],
      close: () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
    server.on('connection', () => {
      fixture.connections += 1;
    });
    server.on('secureConnection', (socket) => {
      fixture.servernames.push(socket.servername || '');
    });
    server.on('request', (req, res) => {
      const path = req.url ?? '/';
      fixture.requests.push({ path, host: req.headers.host });
      req.socket.once('close', () => {
        fixture.closes[path] = (fixture.closes[path] ?? 0) + 1;
      });
      route(req, res, fixture);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // The same object the routes write their counters on, not a copy.
      fixture.port = (server.address() as AddressInfo).port;
      resolve(fixture);
    });
  });
}
