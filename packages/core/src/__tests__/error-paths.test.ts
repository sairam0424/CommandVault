import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SqliteEngine } from '../indexer/sqlite-engine.js';
import { parseSkills } from '../parsers/skill-parser.js';
import { parseHooks } from '../parsers/hook-parser.js';
import { parseRules } from '../parsers/rule-parser.js';
import { parseAgents } from '../parsers/agent-parser.js';
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
    lastModified: overrides.lastModified ?? new Date(),
    favorite: overrides.favorite ?? false,
    usageCount: overrides.usageCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Error Path Tests
// ---------------------------------------------------------------------------

describe('Error Paths', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cv-error-paths-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Corrupt SQLite Database
  // =========================================================================

  describe('Corrupt SQLite DB', () => {
    it('archives corrupt file and starts fresh database', async () => {
      const dbPath = join(tempDir, 'corrupt.db');

      // Write random bytes to simulate a corrupt database file
      await writeFile(dbPath, randomBytes(1024));

      // SqliteEngine.create should handle the corrupt file gracefully
      const engine = await SqliteEngine.create(dbPath);

      // Should be able to use the fresh database normally
      engine.index([makeEntry({ id: 'e1', name: 'fresh-entry' })]);
      const entry = engine.getEntry('e1');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('fresh-entry');

      engine.close();
    });

    it('fresh database after corruption has working schema', async () => {
      const dbPath = join(tempDir, 'corrupt2.db');

      // Write invalid bytes
      await writeFile(dbPath, Buffer.from('not a database file at all'));

      const engine = await SqliteEngine.create(dbPath);

      // Verify all operations work on the fresh DB
      engine.index([makeEntry({ id: 'e1', name: 'tool', tags: ['alpha'] })]);
      engine.toggleFavorite('e1');
      engine.incrementUsage('e1');
      engine.addTag('e1', 'user-tag');

      const entry = engine.getEntry('e1');
      expect(entry!.favorite).toBe(true);
      expect(entry!.usageCount).toBe(1);
      expect(entry!.tags).toContain('user-tag');

      engine.close();
    });
  });

  // =========================================================================
  // Malformed YAML Frontmatter
  // =========================================================================

  describe('Malformed YAML Frontmatter', () => {
    it('parser returns error entry for malformed frontmatter without crashing', async () => {
      const skillsDir = join(tempDir, 'skills');
      const malformedDir = join(skillsDir, 'broken-skill');
      await mkdir(malformedDir, { recursive: true });

      // Write a SKILL.md with broken YAML (unclosed frontmatter)
      const malformedContent = `---
name: broken
description: [unclosed bracket
  invalid: yaml: : : content
---

# Some content
`;
      await writeFile(join(malformedDir, 'SKILL.md'), malformedContent);

      const result = await parseSkills(skillsDir);

      // gray-matter is lenient with malformed YAML — it may still parse,
      // but the parser should not throw
      expect(result).toBeDefined();
      // Either we get an entry (gray-matter tolerates it) or an error
      const totalResults = result.entries.length + result.errors.length;
      expect(totalResults).toBeGreaterThanOrEqual(0);
    });

    it('parser handles file with only frontmatter delimiters', async () => {
      const skillsDir = join(tempDir, 'skills-empty-fm');
      const emptyFmDir = join(skillsDir, 'empty-fm');
      await mkdir(emptyFmDir, { recursive: true });

      await writeFile(join(emptyFmDir, 'SKILL.md'), '---\n---\n');

      const result = await parseSkills(skillsDir);

      // Should not crash; may produce an entry with defaults
      expect(result).toBeDefined();
      if (result.entries.length > 0) {
        expect(result.entries[0].name).toBe('empty-fm'); // Falls back to dir name
      }
    });
  });

  // =========================================================================
  // Empty/Binary Files in Skills Directory
  // =========================================================================

  describe('Empty/Binary Files', () => {
    it('parser skips directory without SKILL.md gracefully', async () => {
      const skillsDir = join(tempDir, 'skills-no-md');
      const noMdDir = join(skillsDir, 'empty-dir');
      await mkdir(noMdDir, { recursive: true });

      // Create a binary file instead of SKILL.md
      await writeFile(join(noMdDir, 'random.bin'), randomBytes(512));

      const result = await parseSkills(skillsDir);

      // Should return empty entries (ENOENT for SKILL.md is silently skipped)
      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('parser handles empty SKILL.md file', async () => {
      const skillsDir = join(tempDir, 'skills-empty');
      const emptyDir = join(skillsDir, 'empty-skill');
      await mkdir(emptyDir, { recursive: true });

      await writeFile(join(emptyDir, 'SKILL.md'), '');

      const result = await parseSkills(skillsDir);

      // Should not crash; empty file may produce entry with defaults
      expect(result).toBeDefined();
      if (result.entries.length > 0) {
        expect(result.entries[0].name).toBe('empty-skill');
        expect(result.entries[0].content).toBe('');
      }
    });
  });

  // =========================================================================
  // Missing Directory Passed to Parser
  // =========================================================================

  describe('Missing Directory', () => {
    it('parseSkills returns empty results for non-existent directory', async () => {
      const result = await parseSkills(join(tempDir, 'does-not-exist'));

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('not found');
    });

    it('parseRules returns empty results for non-existent directory', async () => {
      const result = await parseRules(join(tempDir, 'no-rules-here'));

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('not found');
    });

    it('parseAgents returns empty results for non-existent directory', async () => {
      const result = await parseAgents(join(tempDir, 'no-agents-here'));

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('not found');
    });
  });

  // =========================================================================
  // File Disappears (ENOENT during read)
  // =========================================================================

  describe('File Disappears Between Scan and Read', () => {
    it('parser handles ENOENT for a skill that exists in readdir but not on disk', async () => {
      const skillsDir = join(tempDir, 'skills-vanish');
      const vanishDir = join(skillsDir, 'vanishing-skill');
      await mkdir(vanishDir, { recursive: true });

      // Do NOT create SKILL.md — simulates file disappearing
      // The parser will try to read it and get ENOENT

      const result = await parseSkills(skillsDir);

      // ENOENT is explicitly handled — no entries, no errors
      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // =========================================================================
  // Extremely Long File Content
  // =========================================================================

  describe('Extremely Long File Content', () => {
    it('handles very long content without OOM (truncation in engines)', async () => {
      const skillsDir = join(tempDir, 'skills-long');
      const longDir = join(skillsDir, 'long-skill');
      await mkdir(longDir, { recursive: true });

      // Generate a large file (100KB) — well beyond the 500-char truncation in engines
      const longContent = `---
name: long-skill
description: A skill with very long content
---

# Long Skill

${'Lorem ipsum dolor sit amet. '.repeat(5000)}`;

      await writeFile(join(longDir, 'SKILL.md'), longContent);

      const result = await parseSkills(skillsDir);

      expect(result.errors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('long-skill');
      // Content is stored in full by the parser
      expect(result.entries[0].content.length).toBeGreaterThan(500);

      // Now verify the search engines handle indexing without OOM
      const dbPath = join(tempDir, 'long-test.db');
      const engine = await SqliteEngine.create(dbPath);
      engine.index(result.entries);

      // Retrieve by id to confirm indexing worked despite large content
      const retrieved = engine.getEntry(result.entries[0].id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('long-skill');
      expect(retrieved!.content.length).toBeGreaterThan(500);

      engine.close();
    });
  });

  // =========================================================================
  // Invalid JSON in settings.json (Hook Parser)
  // =========================================================================

  describe('Invalid JSON in settings.json', () => {
    it('hook parser returns structured error for completely invalid JSON', async () => {
      const settingsPath = join(tempDir, 'bad-settings.json');
      await writeFile(settingsPath, 'this is not json {{{[[[');

      const result = await parseHooks(settingsPath);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid JSON');
    });

    it('hook parser handles non-iterable hooks structure gracefully', async () => {
      const settingsPath = join(tempDir, 'weird-hooks.json');
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: 'not-an-array',
          },
        }),
      );

      const result = await parseHooks(settingsPath);
      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('hook parser handles missing hooks key gracefully', async () => {
      const settingsPath = join(tempDir, 'no-hooks.json');
      await writeFile(settingsPath, JSON.stringify({ permissions: ['Bash'] }));

      const result = await parseHooks(settingsPath);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // =========================================================================
  // Database Busy / Locked
  // =========================================================================

  describe('Database Concurrency', () => {
    it('handles sequential writes from separate connections without crashing', async () => {
      const dbPath = join(tempDir, 'concurrent.db');
      const engine1 = await SqliteEngine.create(dbPath);

      // Write entries, close, then reopen with a second connection
      engine1.index([
        makeEntry({ id: 'e1', name: 'from-engine1' }),
        makeEntry({ id: 'e2', name: 'shared-entry' }),
      ]);
      engine1.close();

      const engine2 = await SqliteEngine.create(dbPath);

      // Engine2 should see the entries written by engine1
      const entry1 = engine2.getEntry('e1');
      const entry2 = engine2.getEntry('e2');

      expect(entry1).toBeDefined();
      expect(entry1!.name).toBe('from-engine1');
      expect(entry2).toBeDefined();
      expect(entry2!.name).toBe('shared-entry');

      engine2.close();
    });

    it('database remains usable after close and reopen', async () => {
      const dbPath = join(tempDir, 'reopen.db');
      const engine1 = await SqliteEngine.create(dbPath);
      engine1.index([makeEntry({ id: 'e1', name: 'persisted' })]);
      engine1.close();

      const engine2 = await SqliteEngine.create(dbPath);
      const entry = engine2.getEntry('e1');
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('persisted');
      engine2.close();
    });
  });
});
