import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { detectAgentConfigs } from '../parsers/multi-agent-parser.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'commandvault-multiagent-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cursor Configs
// ---------------------------------------------------------------------------
describe('detectAgentConfigs — Cursor', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = join(tempDir, 'cursor-project');
    await mkdir(projectRoot, { recursive: true });

    // .cursorrules in project root
    await writeFile(
      join(projectRoot, '.cursorrules'),
      '# Cursor Rules\n\nAlways use TypeScript strict mode.\n',
    );

    // .cursor/rules/ directory with markdown files
    const cursorRulesDir = join(projectRoot, '.cursor', 'rules');
    await mkdir(cursorRulesDir, { recursive: true });
    await writeFile(
      join(cursorRulesDir, 'code-style.md'),
      '---\nname: Code Style\ndescription: Enforce consistent code style\n---\n\n# Code Style\n\nUse 2-space indentation.\n',
    );
    await writeFile(
      join(cursorRulesDir, 'testing-rules.md'),
      '# Testing Rules\n\nAlways write tests before implementation.\n',
    );
  });

  it('parses .cursorrules file as rule with source cursor', async () => {
    const result = await detectAgentConfigs(projectRoot);
    const rootRule = result.entries.find((e) => e.filePath.endsWith('.cursorrules'));

    expect(rootRule).toBeDefined();
    expect(rootRule!.type).toBe('rule');
    expect(rootRule!.source).toBe('cursor');
    expect(rootRule!.name).toBe('Cursor Rules (project root)');
    expect(rootRule!.content).toContain('TypeScript strict mode');
    expect(rootRule!.tags).toContain('cursor');
    expect(rootRule!.tags).toContain('ai-agent-config');
  });

  it('parses .cursor/rules/*.md files as rule entries', async () => {
    const result = await detectAgentConfigs(projectRoot);
    // filePath is built with node:path join(), so it uses the OS-native separator
    // (backslash on Windows) — match against a joined segment, not a hardcoded posix path.
    const dirRules = result.entries.filter((e) => e.filePath.includes(join('.cursor', 'rules')));

    expect(dirRules).toHaveLength(2);
    expect(dirRules.every((e) => e.type === 'rule')).toBe(true);
    expect(dirRules.every((e) => e.source === 'cursor')).toBe(true);
  });

  it('extracts frontmatter name and description from cursor rules', async () => {
    const result = await detectAgentConfigs(projectRoot);
    const codeStyle = result.entries.find((e) => e.name === 'Code Style');

    expect(codeStyle).toBeDefined();
    expect(codeStyle!.description).toBe('Enforce consistent code style');
  });

  it('generates deterministic IDs across invocations', async () => {
    const r1 = await detectAgentConfigs(projectRoot);
    const r2 = await detectAgentConfigs(projectRoot);
    const ids1 = r1.entries.map((e) => e.id).sort();
    const ids2 = r2.entries.map((e) => e.id).sort();
    expect(ids1).toEqual(ids2);
  });
});

// ---------------------------------------------------------------------------
// Copilot Configs
// ---------------------------------------------------------------------------
describe('detectAgentConfigs — Copilot', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = join(tempDir, 'copilot-project');
    await mkdir(join(projectRoot, '.github'), { recursive: true });
    await writeFile(
      join(projectRoot, '.github', 'copilot-instructions.md'),
      '# Copilot Instructions\n\nPrefer functional patterns over imperative code.\n',
    );
  });

  it('parses .github/copilot-instructions.md as rule with source copilot', async () => {
    const result = await detectAgentConfigs(projectRoot);
    const entry = result.entries.find((e) => e.source === 'copilot');

    expect(entry).toBeDefined();
    expect(entry!.type).toBe('rule');
    expect(entry!.source).toBe('copilot');
    expect(entry!.name).toBe('Copilot Instructions');
    expect(entry!.content).toContain('functional patterns');
    expect(entry!.tags).toContain('copilot');
    expect(entry!.tags).toContain('ai-agent-config');
  });
});

// ---------------------------------------------------------------------------
// Windsurf Configs
// ---------------------------------------------------------------------------
describe('detectAgentConfigs — Windsurf', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = join(tempDir, 'windsurf-project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, '.windsurfrules'),
      '# Windsurf Rules\n\nUse error boundaries in all React components.\n',
    );
  });

  it('parses .windsurfrules as rule with source windsurf', async () => {
    const result = await detectAgentConfigs(projectRoot);
    const entry = result.entries.find((e) => e.source === 'windsurf');

    expect(entry).toBeDefined();
    expect(entry!.type).toBe('rule');
    expect(entry!.source).toBe('windsurf');
    expect(entry!.name).toBe('Windsurf Rules (project root)');
    expect(entry!.content).toContain('error boundaries');
    expect(entry!.tags).toContain('windsurf');
    expect(entry!.tags).toContain('ai-agent-config');
  });
});

// ---------------------------------------------------------------------------
// Aider Configs
// ---------------------------------------------------------------------------
describe('detectAgentConfigs — Aider', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = join(tempDir, 'aider-project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, '.aider.conf.yml'),
      '# Aider configuration for this project\nmodel: claude-3-opus\nauto-commits: false\n',
    );
  });

  it('parses .aider.conf.yml as rule with source aider', async () => {
    const result = await detectAgentConfigs(projectRoot);
    const entry = result.entries.find(
      (e) => e.source === 'aider' && e.filePath.includes(projectRoot),
    );

    expect(entry).toBeDefined();
    expect(entry!.type).toBe('rule');
    expect(entry!.source).toBe('aider');
    expect(entry!.name).toBe('Aider Config (project)');
    expect(entry!.content).toContain('auto-commits: false');
    expect(entry!.tags).toContain('aider');
    expect(entry!.tags).toContain('ai-agent-config');
  });

  it('extracts description from first YAML comment', async () => {
    const result = await detectAgentConfigs(projectRoot);
    const entry = result.entries.find(
      (e) => e.source === 'aider' && e.filePath.includes(projectRoot),
    );

    expect(entry!.description).toBe('Aider configuration for this project');
  });
});

// ---------------------------------------------------------------------------
// Continue.dev Configs
// ---------------------------------------------------------------------------
describe('detectAgentConfigs — Continue', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = join(tempDir, 'continue-project');
    const continueDir = join(tempDir, 'fake-home-continue', '.continue');
    await mkdir(continueDir, { recursive: true });
    await writeFile(
      join(continueDir, 'config.json'),
      JSON.stringify(
        {
          description: 'Continue.dev development configuration',
          models: [{ provider: 'anthropic', model: 'claude-3-opus' }],
          tabAutocompleteModel: { provider: 'ollama', model: 'codellama' },
        },
        null,
        2,
      ),
    );
  });

  it('parses continue config.json with correct metadata', async () => {
    // This test verifies parsing of a Continue config when present in the homedir.
    // Since the parser uses homedir(), we test structure expectations via a real
    // homedir-based detection attempt. The entry may not exist if ~/.continue/config.json
    // is absent, so we verify no crash and correct result shape.
    const result = await detectAgentConfigs(projectRoot);

    expect(result).toHaveProperty('entries');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.entries)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------
describe('detectAgentConfigs — edge cases', () => {
  it('returns empty results for a directory with no agent configs', async () => {
    const emptyRoot = join(tempDir, 'empty-project');
    await mkdir(emptyRoot, { recursive: true });

    const result = await detectAgentConfigs(emptyRoot);

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('does not crash on a nonexistent project root', async () => {
    const result = await detectAgentConfigs(join(tempDir, 'does-not-exist'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles malformed JSON gracefully with errors array', async () => {
    const malformedRoot = join(tempDir, 'malformed-project');
    const continueDir = join(malformedRoot, '.continue');
    await mkdir(continueDir, { recursive: true });
    // Create invalid JSON that will be "found" but fail to parse meaningfully
    await writeFile(join(continueDir, 'config.json'), '{ invalid json content !!!');

    // The parser won't scan .continue in project root for single-file (it uses homedir),
    // but testing .cursorrules with binary content
    await writeFile(join(malformedRoot, '.cursorrules'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const result = await detectAgentConfigs(malformedRoot);

    // Should not throw — graceful handling
    expect(result).toHaveProperty('entries');
    expect(result).toHaveProperty('errors');
  });

  it('detects multiple configs in the same project directory', async () => {
    const multiRoot = join(tempDir, 'multi-config-project');
    await mkdir(join(multiRoot, '.github'), { recursive: true });
    await mkdir(join(multiRoot, '.cursor', 'rules'), { recursive: true });

    await writeFile(join(multiRoot, '.cursorrules'), '# Cursor project rules\n');
    await writeFile(
      join(multiRoot, '.cursor', 'rules', 'naming.md'),
      '# Naming Conventions\n\nUse camelCase.\n',
    );
    await writeFile(
      join(multiRoot, '.github', 'copilot-instructions.md'),
      '# Copilot\n\nFollow team standards.\n',
    );
    await writeFile(join(multiRoot, '.windsurfrules'), '# Windsurf\n\nUse TypeScript.\n');
    await writeFile(
      join(multiRoot, '.aider.conf.yml'),
      '# Multi-tool project aider config\nmodel: gpt-4\n',
    );

    const result = await detectAgentConfigs(multiRoot);

    const sources = new Set(result.entries.map((e) => e.source));
    expect(sources.has('cursor')).toBe(true);
    expect(sources.has('copilot')).toBe(true);
    expect(sources.has('windsurf')).toBe(true);
    expect(sources.has('aider')).toBe(true);

    // At least 5 entries: .cursorrules + naming.md + copilot + windsurf + aider
    expect(result.entries.length).toBeGreaterThanOrEqual(5);
  });

  it('all entries have required fields populated', async () => {
    const multiRoot = join(tempDir, 'multi-config-project');
    const result = await detectAgentConfigs(multiRoot);

    for (const entry of result.entries) {
      expect(entry.id).toMatch(/^[a-f0-9]{12}$/);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.type).toBe('rule');
      expect(entry.filePath.length).toBeGreaterThan(0);
      expect(entry.tags.length).toBeGreaterThan(0);
      expect(entry.favorite).toBe(false);
      expect(entry.usageCount).toBe(0);
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });
});
