import { describe, it, expect, beforeEach } from 'vitest';
import { ParserRegistry, getDefaultRegistry } from '../parsers/parser-registry.js';
import type { ParserPlugin } from '../parsers/parser-registry.js';
import type { ParserResult } from '../types/index.js';

function makePlugin(overrides: Partial<ParserPlugin> & { type: string }): ParserPlugin {
  return {
    displayName: `${overrides.type} plugin`,
    emoji: '🧩',
    color: 'cyan',
    globPatterns: ['**/*.md'],
    parse: async () => ({ entries: [], errors: [] }) as ParserResult,
    ...overrides,
  };
}

describe('ParserRegistry', () => {
  let registry: ParserRegistry;

  beforeEach(() => {
    registry = new ParserRegistry();
  });

  it('register() adds a plugin that can be retrieved', () => {
    const plugin = makePlugin({ type: 'skill' });
    registry.register(plugin);

    expect(registry.getParser('skill')).toBe(plugin);
  });

  it('getParser() returns undefined for unknown type', () => {
    expect(registry.getParser('nonexistent')).toBeUndefined();
  });

  it('getAllTypes() returns all registered type names', () => {
    registry.register(makePlugin({ type: 'skill' }));
    registry.register(makePlugin({ type: 'agent' }));
    registry.register(makePlugin({ type: 'hook' }));

    const types = registry.getAllTypes();
    expect(types).toContain('skill');
    expect(types).toContain('agent');
    expect(types).toContain('hook');
    expect(types).toHaveLength(3);
  });

  it('getAllPlugins() returns all registered plugins', () => {
    const skill = makePlugin({ type: 'skill' });
    const agent = makePlugin({ type: 'agent' });
    registry.register(skill);
    registry.register(agent);

    const plugins = registry.getAllPlugins();
    expect(plugins).toHaveLength(2);
    expect(plugins).toContain(skill);
    expect(plugins).toContain(agent);
  });

  it('duplicate registration overwrites (last wins)', () => {
    const first = makePlugin({ type: 'skill', displayName: 'first' });
    const second = makePlugin({ type: 'skill', displayName: 'second' });

    registry.register(first);
    registry.register(second);

    expect(registry.getParser('skill')).toBe(second);
    expect(registry.getAllTypes()).toHaveLength(1);
  });

  it('getAllTypes() returns empty array when no plugins registered', () => {
    expect(registry.getAllTypes()).toHaveLength(0);
  });

  it('getAllPlugins() returns empty array when no plugins registered', () => {
    expect(registry.getAllPlugins()).toHaveLength(0);
  });

  describe('getDefaultRegistry()', () => {
    it('returns a singleton ParserRegistry instance', () => {
      const r1 = getDefaultRegistry();
      const r2 = getDefaultRegistry();
      expect(r1).toBe(r2);
      expect(r1).toBeInstanceOf(ParserRegistry);
    });
  });
});
