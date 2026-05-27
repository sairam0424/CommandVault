import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter } from '../parsers/utils.js';
import { parseHooks } from '../parsers/hook-parser.js';
import { validateUrl } from '../sync/index.js';

describe('Security', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-security-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('gray-matter engine injection (CVE prevention)', () => {
    it('disables JavaScript engine — no code execution via ---js frontmatter', () => {
      const malicious = `---js\n{ name: (function(){ throw new Error('RCE executed'); return 'pwned'; })() }\n---\nContent`;
      const result = parseFrontmatter(malicious);
      expect(result.data).toEqual({});
      expect(result.content).not.toContain('pwned');
    });

    it('disables CoffeeScript engine — no code execution via ---coffee frontmatter', () => {
      const malicious = `---coffee\nname: do -> throw new Error('RCE')\n---\nContent`;
      const result = parseFrontmatter(malicious);
      expect(result.data).toEqual({});
    });

    it('standard YAML frontmatter still works correctly', () => {
      const valid = `---\nname: test-skill\ndescription: A valid skill\n---\nBody content`;
      const result = parseFrontmatter(valid);
      expect(result.data.name).toBe('test-skill');
      expect(result.data.description).toBe('A valid skill');
      expect(result.content).toBe('Body content');
    });

    it('empty frontmatter returns empty data', () => {
      const empty = `---\n---\nJust content`;
      const result = parseFrontmatter(empty);
      expect(result.data).toEqual({});
      expect(result.content).toBe('Just content');
    });
  });

  describe('hook parser resilience', () => {
    it('handles non-iterable hooks matchers gracefully (string instead of array)', async () => {
      const settingsPath = join(tempDir, 'bad-hooks.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: 'not-an-array',
            PostToolUse: 42,
            Stop: { not: 'array' },
          },
        }),
      );

      const result = await parseHooks(settingsPath);
      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('handles matcher with non-array hooks field', async () => {
      const settingsPath = join(tempDir, 'bad-matcher.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: 'not-an-array' }],
          },
        }),
      );

      const result = await parseHooks(settingsPath);
      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('reports JSON parse errors distinctly from file-not-found', async () => {
      const settingsPath = join(tempDir, 'malformed.json');
      await writeFile(settingsPath, '{invalid json content!!!');

      const result = await parseHooks(settingsPath);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid JSON');
      expect(result.errors[0].message).not.toContain('not found');
    });

    it('reports file-not-found for missing settings file', async () => {
      const settingsPath = join(tempDir, 'nonexistent.json');

      const result = await parseHooks(settingsPath);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('not found');
    });

    it('valid hooks still parse correctly', async () => {
      const settingsPath = join(tempDir, 'valid.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo hello' }],
              },
            ],
          },
        }),
      );

      const result = await parseHooks(settingsPath);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toContain('PreToolUse:Bash');
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('SSRF validation', () => {
    it('blocks IPv4-mapped IPv6 loopback addresses', () => {
      expect(() => validateUrl('https://[::ffff:127.0.0.1]/api')).toThrow('Blocked');
    });

    it('blocks IPv4-mapped IPv6 private ranges (10.x)', () => {
      expect(() => validateUrl('https://[::ffff:10.0.0.1]/api')).toThrow('Blocked');
    });

    it('blocks IPv4-mapped IPv6 private ranges (192.168.x)', () => {
      expect(() => validateUrl('https://[::ffff:192.168.1.1]/api')).toThrow('Blocked');
    });

    it('blocks IPv4-mapped IPv6 link-local (169.254.x)', () => {
      expect(() => validateUrl('https://[::ffff:169.254.1.1]/api')).toThrow('Blocked');
    });

    it('blocks standard private addresses', () => {
      expect(() => validateUrl('https://127.0.0.1/api')).toThrow('Blocked');
      expect(() => validateUrl('https://10.0.0.1/api')).toThrow('Blocked');
      expect(() => validateUrl('https://192.168.1.1/api')).toThrow('Blocked');
      expect(() => validateUrl('https://localhost/api')).toThrow('Blocked');
    });

    it('allows legitimate public HTTPS URLs', () => {
      expect(() => validateUrl('https://registry.commandvault.dev/entries.json')).not.toThrow();
    });

    it('rejects non-HTTPS URLs', () => {
      expect(() => validateUrl('http://example.com/entries.json')).toThrow('HTTPS');
    });
  });
});
