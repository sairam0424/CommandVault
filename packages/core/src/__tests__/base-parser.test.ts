import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarkdownDir } from '../parsers/base-parser.js';
import type { ParseConfig } from '../parsers/base-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ParseConfig = {
  type: 'skill',
  filePattern: /\.md$/,
  scanMode: 'files',
  dirNotFoundMessage: 'Directory not found',
};

function makeConfig(overrides: Partial<ParseConfig> = {}): ParseConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function mdWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yamlLines = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) {
      return `${k}:\n${v.map((item) => `  - ${item}`).join('\n')}`;
    }
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseMarkdownDir', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-base-parser-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // scanMode: 'files'
  // =========================================================================

  describe('scanMode: files', () => {
    it('parses markdown files and produces entries with correct fields', async () => {
      const content = mdWithFrontmatter(
        { name: 'test-skill', description: 'A test skill' },
        '# Test Skill\n\nBody content here.',
      );
      await writeFile(join(tempDir, 'test-skill.md'), content);

      const result = await parseMarkdownDir(tempDir, makeConfig());

      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);

      const entry = result.entries[0];
      expect(entry.name).toBe('test-skill');
      expect(entry.type).toBe('skill');
      expect(entry.description).toBe('A test skill');
      expect(entry.content).toContain('# Test Skill');
      expect(entry.content).toContain('Body content here.');
      expect(entry.filePath).toBe(join(tempDir, 'test-skill.md'));
      expect(entry.id).toBeTruthy();
      expect(entry.lastModified).toBeInstanceOf(Date);
      expect(entry.favorite).toBe(false);
      expect(entry.usageCount).toBe(0);
    });

    it('extracts tags from frontmatter keywords', async () => {
      const content = mdWithFrontmatter(
        {
          name: 'tagged-skill',
          description: 'A skill about testing and deployment',
          keywords: ['browser', 'automation'],
        },
        'Some content.',
      );
      await writeFile(join(tempDir, 'tagged.md'), content);

      const result = await parseMarkdownDir(tempDir, makeConfig());
      const entry = result.entries[0];

      expect(entry.tags).toContain('browser');
      expect(entry.tags).toContain('automation');
      // Also picks up domain keywords from description
      expect(entry.tags).toContain('testing');
      expect(entry.tags).toContain('deploy');
    });

    it('skips non-markdown files', async () => {
      await writeFile(join(tempDir, 'readme.txt'), 'plain text');
      await writeFile(join(tempDir, 'data.json'), '{}');
      await writeFile(
        join(tempDir, 'valid.md'),
        mdWithFrontmatter({ name: 'valid' }, 'Valid content'),
      );

      const result = await parseMarkdownDir(tempDir, makeConfig());

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('valid');
    });

    it('returns empty entries and an error for missing directory', async () => {
      const result = await parseMarkdownDir(
        join(tempDir, 'nonexistent'),
        makeConfig({ dirNotFoundMessage: 'Skills directory not found' }),
      );

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Skills directory not found');
    });

    it('returns empty entries for an empty directory', async () => {
      const emptyDir = join(tempDir, 'empty');
      await mkdir(emptyDir);

      const result = await parseMarkdownDir(emptyDir, makeConfig());

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('uses filename as name when frontmatter has no name field', async () => {
      const content = mdWithFrontmatter(
        { description: 'No name field' },
        'Body',
      );
      await writeFile(join(tempDir, 'my-tool.md'), content);

      const result = await parseMarkdownDir(tempDir, makeConfig());

      expect(result.entries[0].name).toBe('my-tool');
    });

    it('applies custom nameFromPath when provided', async () => {
      const content = mdWithFrontmatter({ name: 'original' }, 'Body');
      await writeFile(join(tempDir, 'file.md'), content);

      const config = makeConfig({
        nameFromPath: (folderName, _data, _ctx) => `custom-${folderName}`,
      });
      const result = await parseMarkdownDir(tempDir, config);

      // folderName for 'files' mode is basename(dir)
      expect(result.entries[0].name).toContain('custom-');
    });

    it('applies custom extractMetadata when provided', async () => {
      const content = mdWithFrontmatter(
        { name: 'meta-test', version: '2.0.0' },
        'Body',
      );
      await writeFile(join(tempDir, 'meta.md'), content);

      const config = makeConfig({
        extractMetadata: (data) => ({ version: data.version }),
      });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.entries[0].metadata).toEqual({ version: '2.0.0' });
    });

    it('applies custom filePattern to filter files', async () => {
      await writeFile(
        join(tempDir, 'SKILL.md'),
        mdWithFrontmatter({ name: 'skill-file' }, 'Body'),
      );
      await writeFile(
        join(tempDir, 'README.md'),
        mdWithFrontmatter({ name: 'readme-file' }, 'Body'),
      );

      const config = makeConfig({ filePattern: /^SKILL\.md$/ });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('skill-file');
    });
  });

  // =========================================================================
  // scanMode: 'subdirs'
  // =========================================================================

  describe('scanMode: subdirs', () => {
    it('scans subdirectories for files matching the pattern', async () => {
      const subdir = join(tempDir, 'my-agent');
      await mkdir(subdir);
      await writeFile(
        join(subdir, 'AGENT.md'),
        mdWithFrontmatter({ name: 'my-agent', description: 'An agent' }, 'Agent body'),
      );

      const config = makeConfig({
        type: 'agent',
        scanMode: 'subdirs',
        filePattern: /^AGENT\.md$/,
      });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('my-agent');
      expect(result.entries[0].type).toBe('agent');
    });

    it('skips subdirectories with no matching files', async () => {
      const sub1 = join(tempDir, 'has-match');
      const sub2 = join(tempDir, 'no-match');
      await mkdir(sub1);
      await mkdir(sub2);

      await writeFile(
        join(sub1, 'SKILL.md'),
        mdWithFrontmatter({ name: 'found' }, 'Body'),
      );
      await writeFile(join(sub2, 'README.md'), '# Just a readme');

      const config = makeConfig({ scanMode: 'subdirs', filePattern: /^SKILL\.md$/ });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('found');
    });

    it('returns error for nonexistent directory', async () => {
      const config = makeConfig({
        scanMode: 'subdirs',
        dirNotFoundMessage: 'Agents dir missing',
      });
      const result = await parseMarkdownDir(join(tempDir, 'missing'), config);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Agents dir missing');
    });
  });

  // =========================================================================
  // scanMode: 'walk'
  // =========================================================================

  describe('scanMode: walk', () => {
    it('recursively finds files matching the pattern', async () => {
      const nested = join(tempDir, 'level1', 'level2');
      await mkdir(nested, { recursive: true });

      await writeFile(
        join(tempDir, 'top.md'),
        mdWithFrontmatter({ name: 'top-file' }, 'Top body'),
      );
      await writeFile(
        join(nested, 'deep.md'),
        mdWithFrontmatter({ name: 'deep-file' }, 'Deep body'),
      );

      const config = makeConfig({ scanMode: 'walk' });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(2);

      const names = result.entries.map((e) => e.name);
      expect(names).toContain('top-file');
      expect(names).toContain('deep-file');
    });

    it('returns error for nonexistent directory', async () => {
      const config = makeConfig({
        scanMode: 'walk',
        dirNotFoundMessage: 'Walk dir missing',
      });
      const result = await parseMarkdownDir(join(tempDir, 'nope'), config);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Walk dir missing');
    });

    it('skips files not matching the pattern during walk', async () => {
      await writeFile(
        join(tempDir, 'match.md'),
        mdWithFrontmatter({ name: 'matched' }, 'Body'),
      );
      await writeFile(join(tempDir, 'skip.txt'), 'not markdown');
      await writeFile(join(tempDir, 'skip.json'), '{}');

      const config = makeConfig({ scanMode: 'walk' });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('matched');
    });
  });

  // =========================================================================
  // Frontmatter parsing
  // =========================================================================

  describe('frontmatter extraction', () => {
    it('extracts description from frontmatter', async () => {
      const content = mdWithFrontmatter(
        { name: 'desc-test', description: '  A trimmed description  ' },
        'Body',
      );
      await writeFile(join(tempDir, 'desc.md'), content);

      const result = await parseMarkdownDir(tempDir, makeConfig());

      expect(result.entries[0].description).toBe('A trimmed description');
    });

    it('uses custom descriptionFromContent when provided', async () => {
      const content = mdWithFrontmatter({ name: 'custom-desc' }, 'First line.\nSecond line.');
      await writeFile(join(tempDir, 'custom.md'), content);

      const config = makeConfig({
        descriptionFromContent: (_data, body) => body.split('\n')[0],
      });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.entries[0].description).toBe('First line.');
    });

    it('applies postProcessTags when provided', async () => {
      const content = mdWithFrontmatter(
        { name: 'tagged', description: 'A testing tool' },
        'Body',
      );
      await writeFile(join(tempDir, 'tags.md'), content);

      const config = makeConfig({
        postProcessTags: (tags) => [...tags, 'extra-tag'],
      });
      const result = await parseMarkdownDir(tempDir, config);

      expect(result.entries[0].tags).toContain('extra-tag');
    });

    it('generates stable IDs from type + name + source', async () => {
      const content = mdWithFrontmatter({ name: 'stable-id' }, 'Body');
      await writeFile(join(tempDir, 'stable.md'), content);

      const r1 = await parseMarkdownDir(tempDir, makeConfig());
      const r2 = await parseMarkdownDir(tempDir, makeConfig());

      expect(r1.entries[0].id).toBe(r2.entries[0].id);
      expect(r1.entries[0].id).toBeTruthy();
    });
  });
});
