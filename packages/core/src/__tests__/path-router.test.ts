import { describe, it, expect } from 'vitest';
import { routePathToParser } from '../watcher/path-router.js';

const CLAUDE = '/home/user/.claude';

describe('routePathToParser', () => {
  it('routes skills/ paths to skill parser', () => {
    expect(routePathToParser(`${CLAUDE}/skills/browse/SKILL.md`, CLAUDE)).toBe('skill');
    expect(routePathToParser(`${CLAUDE}/skills/review/SKILL.md`, CLAUDE)).toBe('skill');
  });

  it('routes agents/ paths to agent parser', () => {
    expect(routePathToParser(`${CLAUDE}/agents/test-agent.md`, CLAUDE)).toBe('agent');
  });

  it('routes commands/ paths to command parser', () => {
    expect(routePathToParser(`${CLAUDE}/commands/ns/cmd.md`, CLAUDE)).toBe('command');
    expect(routePathToParser(`${CLAUDE}/commands/root-cmd.md`, CLAUDE)).toBe('command');
  });

  it('routes plugins/ paths to plugin parser', () => {
    expect(routePathToParser(`${CLAUDE}/plugins/installed_plugins.json`, CLAUDE)).toBe('plugin');
    expect(routePathToParser(`${CLAUDE}/plugins/cache/some-plugin/plugin.json`, CLAUDE)).toBe('plugin');
  });

  it('routes rules/ paths to rule parser', () => {
    expect(routePathToParser(`${CLAUDE}/rules/coding-style.md`, CLAUDE)).toBe('rule');
  });

  it('routes settings.json to hook parser', () => {
    expect(routePathToParser(`${CLAUDE}/settings.json`, CLAUDE)).toBe('hook');
  });

  it('returns null for unrecognized paths', () => {
    expect(routePathToParser(`${CLAUDE}/unknown/file.txt`, CLAUDE)).toBeNull();
    expect(routePathToParser('/completely/different/path.md', CLAUDE)).toBeNull();
  });

  it('handles paths outside claude directory', () => {
    expect(routePathToParser('/other/skills/SKILL.md', CLAUDE)).toBeNull();
  });
});
