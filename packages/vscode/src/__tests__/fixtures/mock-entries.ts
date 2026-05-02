import { vi } from 'vitest';
import type { VaultEntry, EntryType, SearchResult } from '@commandvault/core';

const now = new Date('2025-06-01T12:00:00Z');
const yesterday = new Date('2025-05-31T12:00:00Z');
const lastWeek = new Date('2025-05-25T12:00:00Z');

export const MOCK_ENTRIES: readonly VaultEntry[] = [
  {
    id: 'skill-1',
    name: 'review',
    type: 'skill',
    source: 'gstack',
    description: 'Code review with staff-engineer rigor',
    filePath: '/home/user/.claude/skills/review.md',
    tags: ['review', 'quality'],
    metadata: { version: '1.0', author: 'gstack' },
    content: '# Review\nRun a code review.',
    lastModified: now,
    favorite: true,
    usageCount: 42,
  },
  {
    id: 'agent-1',
    name: 'deploy-agent',
    type: 'agent',
    source: 'custom',
    description: 'Automated deploy pipeline',
    filePath: '/home/user/.claude/agents/deploy.md',
    tags: ['deploy', 'ci'],
    metadata: { tier: 'production' },
    content: '# Deploy Agent\nHandles deployments.',
    lastModified: yesterday,
    favorite: false,
    usageCount: 15,
  },
  {
    id: 'command-1',
    name: 'vault',
    type: 'command',
    source: 'official',
    description: 'Interactive fuzzy search',
    filePath: '/home/user/.claude/commands/vault.md',
    tags: ['search'],
    metadata: {},
    content: '',
    lastModified: lastWeek,
    favorite: false,
    usageCount: 100,
  },
  {
    id: 'plugin-1',
    name: 'firebase',
    type: 'plugin',
    source: 'community',
    description: 'Firebase integration plugin',
    filePath: '/home/user/.claude/plugins/firebase.md',
    tags: ['firebase', 'backend'],
    metadata: { requires: ['node'] },
    content: '# Firebase Plugin',
    lastModified: now,
    favorite: true,
    usageCount: 0,
  },
  {
    id: 'rule-1',
    name: 'no-mutations',
    type: 'rule',
    source: 'custom',
    description: 'Enforce immutability in all code',
    filePath: '/home/user/.claude/rules/immutability.md',
    tags: ['style', 'immutable'],
    metadata: {},
    content: 'Never mutate objects in place.',
    lastModified: yesterday,
    favorite: false,
    usageCount: 5,
  },
  {
    id: 'hook-1',
    name: 'pre-commit-lint',
    type: 'hook',
    source: 'gstack',
    description: 'Run linter before every commit',
    filePath: '/home/user/.claude/hooks/lint.md',
    tags: ['lint', 'ci'],
    metadata: { event: 'PreToolUse' },
    content: 'lint-staged --config .lintstagedrc',
    lastModified: lastWeek,
    favorite: false,
    usageCount: 0,
  },
  {
    id: 'skill-2',
    name: 'qa',
    type: 'skill',
    source: 'gstack',
    description: 'QA testing with bug fixes',
    filePath: '/home/user/.claude/skills/qa.md',
    tags: ['qa', 'testing'],
    metadata: { version: '2.0' },
    content: '# QA\nFull QA testing.',
    lastModified: yesterday,
    favorite: false,
    usageCount: 30,
  },
  {
    id: 'skill-3',
    name: 'ship',
    type: 'skill',
    source: 'bmad',
    description: 'Ship workflow with changelog',
    filePath: '/home/user/.claude/skills/ship.md',
    tags: ['deploy', 'release'],
    metadata: {},
    content: '# Ship\nRelease workflow.',
    lastModified: now,
    favorite: true,
    usageCount: 20,
  },
] as const;

export function createMockVault(entries: readonly VaultEntry[] = MOCK_ENTRIES) {
  const mutableEntries = [...entries];

  return {
    getAllEntries: vi.fn(() => [...mutableEntries]),
    getEntriesByType: vi.fn((type: EntryType) => mutableEntries.filter((e) => e.type === type)),
    search: vi.fn(
      (options: {
        query: string;
        type?: EntryType;
        tags?: string[];
        limit?: number;
      }): SearchResult[] =>
        mutableEntries
          .filter((e) => e.name.includes(options.query) || e.description.includes(options.query))
          .slice(0, options.limit ?? 50)
          .map((entry) => ({ entry, score: 0.9, matchedFields: ['name'] as readonly string[] })),
    ),
    toggleFavorite: vi.fn().mockReturnValue(true),
    recordUsage: vi.fn(),
    getSlashCommand: vi.fn((e: VaultEntry) => `/${e.name}`),
    getStats: vi.fn(() => ({
      totalEntries: mutableEntries.length,
      byType: {} as Record<string, number>,
      bySource: {} as Record<string, number>,
      favoriteCount: mutableEntries.filter((e) => e.favorite).length,
      lastScanAt: new Date(),
    })),
    scan: vi.fn().mockResolvedValue(undefined),
    addEntries: vi.fn().mockResolvedValue(0),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}
