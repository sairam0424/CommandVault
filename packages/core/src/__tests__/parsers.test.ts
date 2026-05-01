import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile } from 'node:fs/promises';
import { parseSkills } from '../parsers/skill-parser.js';
import { parseAgents } from '../parsers/agent-parser.js';
import { parseCommands } from '../parsers/command-parser.js';
import { parsePlugins } from '../parsers/plugin-parser.js';
import { parseRules } from '../parsers/rule-parser.js';
import { parseHooks } from '../parsers/hook-parser.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

/**
 * Patch the installed_plugins.json so its installPath values point at the real
 * fixture directories on disk (the checked-in file uses placeholders).
 */
let originalPluginRegistry: string;

beforeAll(async () => {
  const registryPath = join(FIXTURES, 'plugins', 'installed_plugins.json');
  originalPluginRegistry = await readFile(registryPath, 'utf-8');

  const cachePath = join(FIXTURES, 'plugins', 'cache');
  const patched = originalPluginRegistry
    .replace('PLACEHOLDER_CACHE_PATH', join(cachePath, 'test-plugin'))
    .replace('PLACEHOLDER_CLAUDE_PLUGIN_PATH', join(cachePath, 'claude-plugin-test'))
    .replace('PLACEHOLDER_PKG_JSON_PATH', join(cachePath, 'pkg-json-test'))
    .replace('PLACEHOLDER_NO_MANIFEST_PATH', join(cachePath, 'no-manifest-test'));

  await writeFile(registryPath, patched, 'utf-8');
});

afterAll(async () => {
  const registryPath = join(FIXTURES, 'plugins', 'installed_plugins.json');
  await writeFile(registryPath, originalPluginRegistry, 'utf-8');
});

// ---------------------------------------------------------------------------
// parseSkills
// ---------------------------------------------------------------------------
describe('parseSkills', () => {
  it('parses a skill with YAML frontmatter from SKILL.md', async () => {
    const result = await parseSkills(join(FIXTURES, 'skills'));

    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const skill = result.entries[0];
    expect(skill.name).toBe('browse');
    expect(skill.type).toBe('skill');
    expect(skill.description).toBe('Fast headless browser for QA testing and site dogfooding');
    expect(skill.tags).toContain('browser');
    expect(skill.tags).toContain('testing');
    expect(skill.tags).toContain('qa');
    expect(skill.metadata.version).toBe('1.21.1');
    expect(skill.metadata.preambleTier).toBe(1);
    expect(skill.metadata.triggers).toEqual([
      'user asks to test a website',
      'user asks to browse a URL',
    ]);
    expect(skill.metadata.allowedTools).toEqual(['Bash', 'Read']);
    expect(skill.metadata.folderName).toBe('browse');
    expect(skill.content).toContain('# Browse Skill');
    expect(skill.filePath).toContain('SKILL.md');
    expect(skill.lastModified).toBeInstanceOf(Date);
    expect(skill.favorite).toBe(false);
    expect(skill.usageCount).toBe(0);
  });

  it('infers source as gstack for a /browse path', async () => {
    const result = await parseSkills(join(FIXTURES, 'skills'));
    const skill = result.entries[0];
    expect(skill.source).toBe('gstack');
  });

  it('generates a deterministic id from filePath', async () => {
    const r1 = await parseSkills(join(FIXTURES, 'skills'));
    const r2 = await parseSkills(join(FIXTURES, 'skills'));
    expect(r1.entries[0].id).toBe(r2.entries[0].id);
    expect(r1.entries[0].id).toMatch(/^[a-f0-9]{12}$/);
  });

  it('returns empty entries for a missing directory', async () => {
    const result = await parseSkills(join(FIXTURES, 'nonexistent-skills'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// parseAgents
// ---------------------------------------------------------------------------
describe('parseAgents', () => {
  it('parses an agent with frontmatter metadata', async () => {
    const result = await parseAgents(join(FIXTURES, 'agents'));

    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const agent = result.entries[0];
    expect(agent.name).toBe('Test Agent');
    expect(agent.type).toBe('agent');
    expect(agent.description).toBe('A test agent for unit testing purposes');
    expect(agent.metadata.color).toBe('#FF5733');
    expect(agent.metadata.emoji).toBe('\u{1F9EA}');
    expect(agent.metadata.vibe).toBe('analytical');
    expect(agent.metadata.fileName).toBe('test-agent.md');
    expect(agent.content).toContain('# Test Agent');
    expect(agent.lastModified).toBeInstanceOf(Date);
  });

  it('infers source as custom for a non-prefixed agent', async () => {
    const result = await parseAgents(join(FIXTURES, 'agents'));
    expect(result.entries[0].source).toBe('custom');
  });

  it('returns empty entries for a missing directory', async () => {
    const result = await parseAgents(join(FIXTURES, 'nonexistent-agents'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// parseCommands
// ---------------------------------------------------------------------------
describe('parseCommands', () => {
  it('parses a namespaced command from a subdirectory', async () => {
    const result = await parseCommands(join(FIXTURES, 'commands'));

    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const cmd = result.entries[0];
    expect(cmd.name).toBe('testns:test-cmd');
    expect(cmd.type).toBe('command');
    expect(cmd.description).toBe('Run the test command for QA validation');
    expect(cmd.metadata.namespace).toBe('testns');
    expect(cmd.metadata.fileName).toBe('test-cmd.md');
    expect(cmd.content).toContain('npm run test');
    expect(cmd.source).toBe('custom');
    expect(cmd.tags).toContain('qa');
  });

  it('returns empty entries for a missing directory', async () => {
    const result = await parseCommands(join(FIXTURES, 'nonexistent-commands'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// parsePlugins
// ---------------------------------------------------------------------------
describe('parsePlugins', () => {
  it('parses a plugin from registry + manifest', async () => {
    const result = await parsePlugins(join(FIXTURES, 'plugins'));

    const plugin = result.entries.find((e) => e.name === 'test-plugin');
    expect(plugin).toBeDefined();
    expect(plugin!.type).toBe('plugin');
    expect(plugin!.description).toBe('A test plugin for unit testing the plugin parser');
    expect(plugin!.metadata.version).toBe('1.0.0');
    expect(plugin!.metadata.author).toBe('Test Author');
    expect(plugin!.metadata.homepage).toBe('https://github.com/test/test-plugin');
    expect(plugin!.metadata.license).toBe('MIT');
    expect(plugin!.metadata.scope).toBe('user');
    expect(plugin!.metadata.registryKey).toBe('@test/test-plugin@1.0.0');
    expect(plugin!.metadata.skills).toEqual(['test-skill-a', 'test-skill-b']);
    expect(plugin!.metadata.gitCommitSha).toBe('abc123def456');
    expect(plugin!.tags).toContain('testing');
    expect(plugin!.tags).toContain('qa');
    expect(plugin!.lastModified).toBeInstanceOf(Date);
    expect(plugin!.lastModified.toISOString()).toBe('2025-07-01T14:30:00.000Z');
  });

  it('stores the full manifest JSON as content', async () => {
    const result = await parsePlugins(join(FIXTURES, 'plugins'));
    const plugin = result.entries.find((e) => e.name === 'test-plugin');
    expect(plugin).toBeDefined();
    const content = JSON.parse(plugin!.content);
    expect(content.name).toBe('test-plugin');
    expect(content.license).toBe('MIT');
  });

  it('resolves manifest from .claude-plugin/plugin.json path', async () => {
    const result = await parsePlugins(join(FIXTURES, 'plugins'));

    const plugin = result.entries.find((e) => e.name === 'claude-plugin-test');
    expect(plugin).toBeDefined();
    expect(plugin!.type).toBe('plugin');
    expect(plugin!.description).toBe('Plugin with manifest in .claude-plugin directory');
    expect(plugin!.metadata.version).toBe('2.0.0');
    expect(plugin!.metadata.author).toBe('Claude Test');
    expect(plugin!.metadata.license).toBe('Apache-2.0');
    expect(plugin!.metadata.registryKey).toBe('claude-plugin-test@claude-plugins-official');
    expect(plugin!.metadata.skills).toEqual(['cp-skill-a']);
    expect(plugin!.filePath).toContain('.claude-plugin');
    expect(plugin!.filePath).toContain('plugin.json');
    expect(plugin!.tags).toContain('testing');
    expect(plugin!.tags).toContain('claude-plugin');
    expect(plugin!.lastModified.toISOString()).toBe('2025-08-15T12:00:00.000Z');

    const content = JSON.parse(plugin!.content);
    expect(content.name).toBe('claude-plugin-test');
  });

  it('falls back to package.json', async () => {
    const result = await parsePlugins(join(FIXTURES, 'plugins'));

    const plugin = result.entries.find((e) => e.name === 'pkg-json-test');
    expect(plugin).toBeDefined();
    expect(plugin!.type).toBe('plugin');
    expect(plugin!.description).toBe('Plugin resolved from package.json fallback');
    expect(plugin!.metadata.version).toBe('3.1.0');
    expect(plugin!.metadata.author).toBe('Package Author');
    expect(plugin!.metadata.homepage).toBe('https://github.com/test/pkg-json-test');
    expect(plugin!.metadata.license).toBe('ISC');
    expect(plugin!.metadata.registryKey).toBe('pkg-json-test@community');
    expect(plugin!.filePath).toContain('package.json');
    expect(plugin!.tags).toContain('npm');
    expect(plugin!.tags).toContain('fallback');
    expect(plugin!.lastModified.toISOString()).toBe('2025-09-10T08:00:00.000Z');
  });

  it('creates entry from registry key when no manifest exists', async () => {
    const result = await parsePlugins(join(FIXTURES, 'plugins'));

    const plugin = result.entries.find((e) => e.name === 'no-manifest-test');
    expect(plugin).toBeDefined();
    expect(plugin!.type).toBe('plugin');
    expect(plugin!.description).toBe('');
    expect(plugin!.metadata.version).toBe('0.5.0');
    expect(plugin!.metadata.registryKey).toBe('no-manifest-test@lsp-tools');
    expect(plugin!.lastModified.toISOString()).toBe('2025-09-20T16:00:00.000Z');
  });

  it('returns all 4 plugins with zero errors', async () => {
    const result = await parsePlugins(join(FIXTURES, 'plugins'));

    expect(result.entries).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
  });

  it('returns empty entries when registry file is missing', async () => {
    const result = await parsePlugins(join(FIXTURES, 'nonexistent-plugins'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// parseRules
// ---------------------------------------------------------------------------
describe('parseRules', () => {
  it('parses a rule with frontmatter description and keywords', async () => {
    const result = await parseRules(join(FIXTURES, 'rules'));

    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const rule = result.entries[0];
    expect(rule.name).toBe('test rule');
    expect(rule.type).toBe('rule');
    expect(rule.source).toBe('custom');
    expect(rule.description).toBe('Enforce secure coding practices across the project');
    expect(rule.tags).toContain('rule');
    expect(rule.tags).toContain('security');
    expect(rule.tags).toContain('validation');
    expect(rule.metadata.fileName).toBe('test-rule.md');
    expect(rule.content).toContain('# Security Rules');
  });

  it('returns empty entries for a missing directory', async () => {
    const result = await parseRules(join(FIXTURES, 'nonexistent-rules'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// parseHooks
// ---------------------------------------------------------------------------
describe('parseHooks', () => {
  it('parses PreToolUse hooks from settings.json', async () => {
    const result = await parseHooks(join(FIXTURES, 'settings.json'));

    expect(result.entries).toHaveLength(1);

    const hook = result.entries[0];
    expect(hook.type).toBe('hook');
    expect(hook.source).toBe('custom');
    expect(hook.name).toBe('PreToolUse:Bash:test-hook-guard');
    expect(hook.description).toContain('PreToolUse');
    expect(hook.description).toContain('Bash');
    expect(hook.description).toContain('test-hook-guard');
    expect(hook.tags).toContain('hook');
    expect(hook.tags).toContain('pretooluse');
    expect(hook.tags).toContain('bash');
    expect(hook.metadata.event).toBe('PreToolUse');
    expect(hook.metadata.matcher).toBe('Bash');
    expect(hook.metadata.hookType).toBe('command');
    expect(hook.metadata.timeout).toBe(5000);
    expect(hook.metadata.command).toContain('test-hook-guard.js');
  });

  it('returns empty entries when settings file is missing', async () => {
    const result = await parseHooks(join(FIXTURES, 'nonexistent-settings.json'));

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('not found');
  });

  it('returns empty entries when settings has no hooks key', async () => {
    // The hook parser reads a JSON and checks for the hooks key.
    // We can simulate this by pointing at the plugin manifest (valid JSON, no hooks).
    const noHooksPath = join(FIXTURES, 'plugins', 'cache', 'test-plugin', 'plugin.json');
    const result = await parseHooks(noHooksPath);

    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
