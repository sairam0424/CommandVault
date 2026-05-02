import type { VaultEntry, SearchResult, VaultStats } from '@commandvault/core';

export function makeMockEntry(
  overrides: Partial<VaultEntry> & { id: string; name: string },
): VaultEntry {
  return {
    type: 'skill',
    source: 'gstack',
    description: 'A mock entry for testing',
    filePath: '/home/user/.claude/skills/test/SKILL.md',
    tags: ['testing'],
    metadata: {},
    content: '# Mock content',
    lastModified: new Date('2025-06-01'),
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

export const MOCK_ENTRIES: readonly VaultEntry[] = [
  makeMockEntry({
    id: 'sk1',
    name: 'browse',
    type: 'skill',
    source: 'gstack',
    description: 'Fast headless browser',
    tags: ['browser', 'testing'],
  }),
  makeMockEntry({
    id: 'sk2',
    name: 'review',
    type: 'skill',
    source: 'gstack',
    description: 'Staff-level code review',
    tags: ['review', 'quality'],
  }),
  makeMockEntry({
    id: 'ag1',
    name: 'code-reviewer',
    type: 'agent',
    source: 'superpowers',
    description: 'Reviews code for quality issues',
  }),
  makeMockEntry({
    id: 'cm1',
    name: 'deploy:prod',
    type: 'command',
    source: 'custom',
    description: 'Deploy to production',
    tags: ['deploy'],
  }),
  makeMockEntry({
    id: 'pl1',
    name: 'github',
    type: 'plugin',
    source: 'official',
    description: 'GitHub integration',
    tags: ['github'],
  }),
  makeMockEntry({
    id: 'rl1',
    name: 'security',
    type: 'rule',
    source: 'custom',
    description: 'Enforce security best practices',
    tags: ['security'],
  }),
  makeMockEntry({
    id: 'hk1',
    name: 'PreToolUse:Bash:guard',
    type: 'hook',
    source: 'custom',
    description: 'Pre-tool use guard hook',
  }),
];

export const MOCK_STATS: VaultStats = {
  totalEntries: MOCK_ENTRIES.length,
  byType: {
    skill: 2,
    agent: 1,
    command: 1,
    plugin: 1,
    rule: 1,
    hook: 1,
  },
  bySource: { gstack: 2, superpowers: 1, custom: 3, official: 1 },
  favoriteCount: 0,
  lastScanAt: new Date('2025-06-01'),
};

export function mockSearchResults(query: string): SearchResult[] {
  const lq = query.toLowerCase();
  return MOCK_ENTRIES.filter(
    (e) => e.name.toLowerCase().includes(lq) || e.description.toLowerCase().includes(lq),
  ).map((entry, i) => ({ entry, score: 1 - i * 0.1, matchedFields: ['name'] }));
}
