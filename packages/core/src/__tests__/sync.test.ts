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
import type { VaultEntry } from '../types/index.js';

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
    it('successfully fetches and parses a valid remote bundle', async () => {
      const bundle = makeValidBundle();
      const mockResponse = new Response(JSON.stringify(bundle), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/vault-bundle.json');

      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('deploy-tool');
      expect(result.entries[0].tags).toContain('synced');
      expect(result.entries[0].tags).toContain('from:example.com');
    });

    it('returns error for non-200 HTTP responses', async () => {
      const mockResponse = new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/missing.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('HTTP 404');
    });

    it('rejects responses over size limit (content-length header)', async () => {
      const mockResponse = new Response('', {
        status: 200,
        headers: { 'content-length': String(11 * 1024 * 1024) }, // 11MB
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/huge.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('too large');
    });

    it('rejects responses over size limit (body exceeds 10MB)', async () => {
      const hugeText = 'x'.repeat(11 * 1024 * 1024);
      const mockResponse = new Response(hugeText, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/huge-body.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('10MB');
    });

    it('returns error for invalid JSON response', async () => {
      const mockResponse = new Response('not json at all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/bad.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('not valid JSON');
    });

    it('returns error for JSON that is not a valid bundle', async () => {
      const mockResponse = new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/not-bundle.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('not a valid CommandVault bundle');
    });

    it('handles network errors gracefully', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network unreachable'));

      const result = await importFromUrl('https://example.com/down.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('Fetch failed');
      expect(result.errors[0].message).toContain('Network unreachable');
    });

    it('handles abort/timeout errors', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

      const result = await importFromUrl('https://example.com/slow.json');

      expect(result.entries).toHaveLength(0);
      expect(result.errors[0].message).toContain('timed out');
    });

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
      const mockResponse = new Response(JSON.stringify(bundle), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

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
      const mockResponse = new Response(JSON.stringify(bundle), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);

      const result = await importFromUrl('https://example.com/ext.json');

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].source).toBe('community');
    });
  });
});
