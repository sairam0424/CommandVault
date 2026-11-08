import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  exportEntries,
  exportToFile,
  importFromFile,
  importFromUrl,
  type VaultExportBundle,
  type ExportedEntry,
} from '../sync/index.js';
import { safeFetchText, SafeFetchError, type SafeFetchCode } from '../net/safe-fetch.js';
import type { VaultEntry } from '../types/index.js';

// The network is the fetcher's business (net/safe-fetch-*.test.ts); here it is a mock that either
// returns a body or throws one of its own errors, so the mapping into ParseError is what is tested.
// Unscripted, it still applies the real URL policy (the check that used to be `validateUrl`).
vi.mock('../net/safe-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../net/safe-fetch.js')>();
  return {
    ...actual,
    safeFetchText: vi.fn(
      async (url: string, options?: { allowPrivateHosts?: readonly string[] }) => {
        actual.assertRemoteUrl(url, options);
        throw new Error('unscripted fetch in test');
      },
    ),
  };
});

const fetcher = vi.mocked(safeFetchText);

function serve(text: string, status = 200): void {
  fetcher.mockResolvedValue({ status, text });
}

function refuse(code: SafeFetchCode, message: string, status?: number): void {
  fetcher.mockRejectedValue(new SafeFetchError(code, message, { status }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: overrides.id ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? 'test-entry',
    type: overrides.type ?? 'skill',
    source: overrides.source ?? 'custom',
    description: overrides.description ?? 'A test entry',
    filePath: overrides.filePath ?? '/tmp/test.md',
    tags: overrides.tags ?? ['test'],
    metadata: overrides.metadata ?? {},
    content: overrides.content ?? 'test content',
    lastModified: overrides.lastModified ?? new Date('2024-01-01'),
    favorite: overrides.favorite ?? false,
    usageCount: overrides.usageCount ?? 0,
  };
}

function makeValidBundle(overrides: Partial<VaultExportBundle> = {}): VaultExportBundle {
  const entries: readonly ExportedEntry[] = overrides.entries ?? [
    {
      name: 'deploy-tool',
      type: 'skill',
      source: 'gstack',
      description: 'Deploys applications',
      tags: ['deploy', 'ci'],
      metadata: {},
      content: 'deploy command content',
    },
  ];
  return {
    version: overrides.version ?? '1.0',
    exportedAt: overrides.exportedAt ?? '2024-06-15T10:00:00.000Z',
    source: overrides.source ?? 'test-vault',
    totalEntries: overrides.totalEntries ?? entries.length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Sync Module', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'vault-sync-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Export
  // =========================================================================

  describe('exportEntries()', () => {
    it('returns a valid VaultBundle structure', () => {
      const entries = [makeEntry({ name: 'alpha' }), makeEntry({ name: 'beta' })];

      const bundle = exportEntries(entries, 'my-vault');

      expect(bundle.version).toBe('1.0');
      expect(bundle.source).toBe('my-vault');
      expect(bundle.totalEntries).toBe(2);
      expect(Array.isArray(bundle.entries)).toBe(true);
      expect(bundle.entries).toHaveLength(2);
    });

    it('includes an ISO timestamp in exportedAt', () => {
      const entries = [makeEntry()];

      const bundle = exportEntries(entries, 'test');

      expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Verify it parses as a valid date
      expect(new Date(bundle.exportedAt).getTime()).not.toBeNaN();
    });

    it('serializes entry fields correctly (no id, filePath, lastModified, favorite, usageCount)', () => {
      const entry = makeEntry({
        id: 'should-not-appear',
        name: 'my-skill',
        type: 'agent',
        source: 'bmad',
        description: 'does things',
        filePath: '/some/path.md',
        tags: ['tag1', 'tag2'],
        metadata: { author: 'test' },
        content: 'body content',
        favorite: true,
        usageCount: 42,
      });

      const bundle = exportEntries([entry], 'source');
      const exported = bundle.entries[0];

      expect(exported.name).toBe('my-skill');
      expect(exported.type).toBe('agent');
      expect(exported.source).toBe('bmad');
      expect(exported.description).toBe('does things');
      expect(exported.tags).toEqual(['tag1', 'tag2']);
      expect(exported.metadata).toEqual({ author: 'test' });
      expect(exported.content).toBe('body content');
      // These fields should NOT be in exported entry
      const raw = exported as unknown as Record<string, unknown>;
      expect(raw['id']).toBeUndefined();
      expect(raw['filePath']).toBeUndefined();
      expect(raw['lastModified']).toBeUndefined();
      expect(raw['favorite']).toBeUndefined();
      expect(raw['usageCount']).toBeUndefined();
    });

    it('handles empty entries array', () => {
      const bundle = exportEntries([], 'empty-vault');

      expect(bundle.totalEntries).toBe(0);
      expect(bundle.entries).toHaveLength(0);
    });
  });

  describe('exportToFile()', () => {
    it('writes a valid JSON file and returns entry count', async () => {
      const entries = [makeEntry({ name: 'tool-a' }), makeEntry({ name: 'tool-b' })];
      const outputPath = join(tempDir, 'export.json');

      const count = await exportToFile(entries, outputPath, 'test-export');

      expect(count).toBe(2);
      const raw = await readFile(outputPath, 'utf-8');
      const parsed = JSON.parse(raw) as VaultExportBundle;
      expect(parsed.version).toBe('1.0');
      expect(parsed.entries).toHaveLength(2);
    });
  });

  // =========================================================================
  // Import from File
  // =========================================================================

  describe('importFromFile()', () => {
    it('reads and parses a valid bundle file', async () => {
      const bundle = makeValidBundle();
      const filePath = join(tempDir, 'valid-bundle.json');
      await writeFile(filePath, JSON.stringify(bundle), 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('deploy-tool');
      expect(result.entries[0].type).toBe('skill');
      expect(result.entries[0].source).toBe('gstack');
      expect(result.entries[0].tags).toContain('imported');
      expect(result.entries[0].tags).toContain('from:test-vault');
    });

    it('returns error for non-existent file', async () => {
      const result = await importFromFile('/nonexistent/path.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Cannot read file');
    });

    it('rejects malformed JSON', async () => {
      const filePath = join(tempDir, 'bad.json');
      await writeFile(filePath, '{ this is not json !!!', 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Invalid JSON format');
    });

    it('rejects bundles with missing version field', async () => {
      const filePath = join(tempDir, 'no-version.json');
      await writeFile(filePath, JSON.stringify({ entries: [] }), 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('missing version or entries');
    });

    it('rejects bundles with missing entries field', async () => {
      const filePath = join(tempDir, 'no-entries.json');
      await writeFile(filePath, JSON.stringify({ version: '1.0' }), 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('missing version or entries');
    });

    it('skips entries with missing name or type', async () => {
      const bundle = makeValidBundle({
        entries: [
          {
            name: '',
            type: 'skill',
            source: 'custom',
            description: '',
            tags: [],
            metadata: {},
            content: '',
          },
          {
            name: 'valid',
            type: 'skill',
            source: 'custom',
            description: 'ok',
            tags: [],
            metadata: {},
            content: 'body',
          },
        ],
      });
      const filePath = join(tempDir, 'partial.json');
      await writeFile(filePath, JSON.stringify(bundle), 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('valid');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('missing name or type');
    });

    it('rejects entries with invalid type', async () => {
      const bundle = makeValidBundle({
        entries: [
          {
            name: 'bad-type',
            type: 'invalid-type' as VaultEntry['type'],
            source: 'custom',
            description: '',
            tags: [],
            metadata: {},
            content: '',
          },
        ],
      });
      const filePath = join(tempDir, 'bad-type.json');
      await writeFile(filePath, JSON.stringify(bundle), 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid entry type');
    });

    it('falls back to "custom" source for unrecognized source values', async () => {
      const bundle = makeValidBundle({
        entries: [
          {
            name: 'unknown-src',
            type: 'hook',
            source: 'totally-unknown' as VaultEntry['source'],
            description: '',
            tags: [],
            metadata: {},
            content: '',
          },
        ],
      });
      const filePath = join(tempDir, 'unknown-source.json');
      await writeFile(filePath, JSON.stringify(bundle), 'utf-8');

      const result = await importFromFile(filePath);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].source).toBe('custom');
    });
  });

  // =========================================================================
  // URL Validation (SSRF Protection)
  // =========================================================================

  describe('URL validation (SSRF protection)', () => {
    it('rejects localhost URL', async () => {
      const result = await importFromUrl('https://localhost/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Blocked');
      expect(result.errors[0].message).toContain('localhost');
    });

    it('rejects 127.0.0.1', async () => {
      const result = await importFromUrl('https://127.0.0.1/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Blocked');
    });

    it('rejects IPv6 loopback [::1]', async () => {
      const result = await importFromUrl('https://[::1]/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Blocked');
    });

    it('rejects private 10.x.x.x network', async () => {
      const result = await importFromUrl('https://10.0.0.1/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Blocked');
    });

    it('rejects private 172.16-31.x.x network', async () => {
      const result = await importFromUrl('https://172.16.0.1/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Blocked');
    });

    it('rejects private 192.168.x.x network', async () => {
      const result = await importFromUrl('https://192.168.1.1/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Blocked');
    });

    it('rejects cloud metadata endpoint 169.254.169.254', async () => {
      const result = await importFromUrl('https://169.254.169.254/latest/meta-data/');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Blocked');
    });

    it('rejects non-HTTPS protocols (HTTP)', async () => {
      const result = await importFromUrl('http://example.com/bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Only HTTPS URLs are supported');
    });

    it('rejects file:// protocol', async () => {
      const result = await importFromUrl('file:///etc/passwd');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('URL validation failed');
    });
  });

  // =========================================================================
  // Import from URL
  // =========================================================================

  describe('importFromUrl()', () => {
    afterEach(() => {
      fetcher.mockReset();
    });

    it('successfully fetches and parses a valid remote bundle through the fetcher', async () => {
      serve(JSON.stringify(makeValidBundle()));

      const result = await importFromUrl('https://example.com/vault-bundle.json');

      expect(fetcher).toHaveBeenCalledWith('https://example.com/vault-bundle.json', {
        allowPrivateHosts: undefined,
      });
      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('deploy-tool');
      expect(result.entries[0].tags).toEqual(['deploy', 'ci', 'synced', 'from:example.com']);
    });

    it('hands the allow-list to the fetcher', async () => {
      serve(JSON.stringify(makeValidBundle()));

      await importFromUrl('https://localhost/bundle.json', { allowPrivateHosts: ['localhost'] });

      expect(fetcher).toHaveBeenCalledWith('https://localhost/bundle.json', {
        allowPrivateHosts: ['localhost'],
      });
    });

    it('reports a non-2xx status by number only', async () => {
      refuse('http_status', 'HTTP 404', 404);

      const result = await importFromUrl('https://example.com/missing.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toEqual([
        { filePath: 'https://example.com/missing.json', message: 'HTTP 404' },
      ]);
    });

    it('reports an oversized response with the cap', async () => {
      refuse('too_large', 'Response exceeds 10 MiB');

      const result = await importFromUrl('https://example.com/huge.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toBe('Response exceeds 10 MiB');
    });

    it.each([
      ['headers_timeout', 'no response headers within 15 s'],
      ['idle_timeout', 'no data for 15 s'],
      ['total_timeout', 'response not complete within 60 s'],
    ] as const)('maps %s to a timed-out error', async (code, reason) => {
      refuse(code, reason);

      const result = await importFromUrl('https://example.com/slow.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toBe(`Request timed out (${reason})`);
    });

    it('keeps a blocked host as the fetcher words it', async () => {
      refuse(
        'blocked_host',
        'Blocked: private/internal URL "evil.test" resolves to 127.0.0.1; to allow it add the host to the allowPrivateHosts config key',
      );

      const result = await importFromUrl('https://evil.test/bundle.json');

      expect(result.errors[0].message).toMatch(/^Blocked: private\/internal URL "evil.test"/);
    });

    it.each([
      ['redirect', 'redirect refused (HTTP 302)'],
      ['tls', 'TLS handshake with "example.com" failed (CERT_HAS_EXPIRED)'],
      ['network', 'Connection to "example.com" failed (ECONNREFUSED)'],
      ['dns', 'Cannot resolve "example.com" (ENOTFOUND)'],
      ['unsupported_encoding', 'unsupported content-encoding (compressed responses are refused)'],
    ] as const)('passes a %s failure through unchanged', async (code, message) => {
      refuse(code, message);

      const result = await importFromUrl('https://example.com/down.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toEqual([{ filePath: 'https://example.com/down.json', message }]);
    });

    it('labels an unexpected (non-fetcher) error as a fetch failure', async () => {
      fetcher.mockRejectedValue(new Error('socket hang up'));

      const result = await importFromUrl('https://example.com/down.json');

      expect(result.errors[0].message).toBe('Fetch failed: socket hang up');
    });

    it('returns error for invalid JSON response', async () => {
      serve('not json at all');

      const result = await importFromUrl('https://example.com/bad.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('not valid JSON');
    });

    it('returns error for JSON that is not a valid bundle', async () => {
      serve(JSON.stringify({ foo: 'bar' }));

      const result = await importFromUrl('https://example.com/not-bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('not a valid CommandVault bundle');
    });

    it.each([
      ['null', 'null'],
      ['a string', JSON.stringify('just a string')],
      ['an array', JSON.stringify([{ version: '1.0', entries: [] }])],
    ])(
      'returns error for a JSON body that is %s rather than a bundle object',
      async (_shape, body) => {
        serve(body);

        const result = await importFromUrl('https://example.com/odd.json');

        expect(result.entries).toHaveLength(0);
        expect(result.errors).toEqual([
          {
            filePath: 'https://example.com/odd.json',
            message: 'Remote response is not a valid CommandVault bundle',
          },
        ]);
      },
    );

    it('skips a null entry in a remote bundle instead of throwing', async () => {
      serve(
        JSON.stringify({
          version: '1.0',
          entries: [null, 'text', { name: 'kept', type: 'skill', source: 'community' }],
        }),
      );

      const result = await importFromUrl('https://example.com/null-entry.json');

      expect(result.errors).toHaveLength(0);
      expect(result.entries.map((entry) => entry.name)).toEqual(['kept']);
    });

    // `tags` is spread into the entry's tag list; only an array may be spread. An object, number or
    // boolean used to throw a TypeError out of importFromUrl (breaking the ParserResult contract),
    // and a string would have been split into its characters.
    it.each([
      ['an object', {}],
      ['a number', 7],
      ['a boolean', true],
      ['a string', 'abc'],
    ])(
      'keeps an entry whose tags field is %s, without its tags and without throwing',
      async (_shape, tags) => {
        serve(
          JSON.stringify({
            version: '1.0',
            entries: [{ name: 'odd-tags', type: 'skill', source: 'community', tags }],
          }),
        );

        const result = await importFromUrl('https://example.com/odd-tags.json');

        expect(result.errors).toHaveLength(0);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].tags).toEqual(['synced', 'from:example.com']);
      },
    );

    it('filters out entries with invalid types from remote bundle', async () => {
      const bundle = makeValidBundle({
        entries: [
          {
            name: 'good',
            type: 'skill',
            source: 'custom',
            description: '',
            tags: [],
            metadata: {},
            content: 'ok',
          },
          {
            name: 'bad',
            type: 'nope' as VaultEntry['type'],
            source: 'custom',
            description: '',
            tags: [],
            metadata: {},
            content: '',
          },
        ],
      });
      serve(JSON.stringify(bundle));

      const result = await importFromUrl('https://example.com/mixed.json');

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('good');
    });

    it('defaults unrecognized source to "community" for URL imports', async () => {
      const bundle = makeValidBundle({
        entries: [
          {
            name: 'ext-tool',
            type: 'plugin',
            source: 'unknown-platform' as VaultEntry['source'],
            description: '',
            tags: [],
            metadata: {},
            content: '',
          },
        ],
      });
      serve(JSON.stringify(bundle));

      const result = await importFromUrl('https://example.com/ext.json');

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].source).toBe('community');
    });
  });
});
