import { describe, it, expect, beforeEach } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { EntriesProvider } from '../providers/entries-provider';
import { createMockVault, MOCK_ENTRIES } from './fixtures/mock-entries';
import type { Vault, VaultEntry } from '@commandvault/core';

describe('EntriesProvider', () => {
  let provider: EntriesProvider;
  let vault: ReturnType<typeof createMockVault>;

  beforeEach(() => {
    vault = createMockVault();
    provider = new EntriesProvider(vault as unknown as Vault);
  });

  describe('getRootNodes', () => {
    it('returns type groups with correct counts', () => {
      const roots = provider.getChildren();

      expect(roots.length).toBeGreaterThan(0);

      const typeGroups = roots.filter(
        (n): n is Extract<typeof n, { kind: 'type' }> => n.kind === 'type',
      );

      const skillGroup = typeGroups.find((n) => n.type === 'skill');
      expect(skillGroup).toBeDefined();
      expect(skillGroup!.count).toBe(3);

      const agentGroup = typeGroups.find((n) => n.type === 'agent');
      expect(agentGroup).toBeDefined();
      expect(agentGroup!.count).toBe(1);

      const commandGroup = typeGroups.find((n) => n.type === 'command');
      expect(commandGroup).toBeDefined();
      expect(commandGroup!.count).toBe(1);
    });

    it('only includes types that have entries', () => {
      const singleEntry: VaultEntry[] = [{ ...MOCK_ENTRIES[0], type: 'skill' }];
      vault = createMockVault(singleEntry);
      provider = new EntriesProvider(vault as unknown as Vault);

      const roots = provider.getChildren();
      expect(roots).toHaveLength(1);
      expect(roots[0].kind).toBe('type');
      if (roots[0].kind === 'type') {
        expect(roots[0].type).toBe('skill');
      }
    });

    it('returns all 6 types when each has entries', () => {
      const roots = provider.getChildren();
      const types = roots
        .filter((n): n is Extract<typeof n, { kind: 'type' }> => n.kind === 'type')
        .map((n) => n.type);

      expect(types).toContain('skill');
      expect(types).toContain('agent');
      expect(types).toContain('command');
      expect(types).toContain('plugin');
      expect(types).toContain('rule');
      expect(types).toContain('hook');
    });
  });

  describe('filtering', () => {
    it('filters entries by name', () => {
      provider.setFilter('review');
      const roots = provider.getChildren();

      const typeGroups = roots.filter(
        (n): n is Extract<typeof n, { kind: 'type' }> => n.kind === 'type',
      );
      const skillGroup = typeGroups.find((n) => n.type === 'skill');
      expect(skillGroup).toBeDefined();
      expect(skillGroup!.count).toBe(1);
    });

    it('filters entries by description', () => {
      provider.setFilter('immutability');
      const roots = provider.getChildren();

      const typeGroups = roots.filter(
        (n): n is Extract<typeof n, { kind: 'type' }> => n.kind === 'type',
      );
      const ruleGroup = typeGroups.find((n) => n.type === 'rule');
      expect(ruleGroup).toBeDefined();
      expect(ruleGroup!.count).toBe(1);
    });

    it('returns all types when filter is empty', () => {
      provider.setFilter('');
      const roots = provider.getChildren();
      expect(roots.length).toBe(6);
    });

    it('returns empty when filter matches nothing', () => {
      provider.setFilter('zzz_nonexistent_zzz');
      const roots = provider.getChildren();
      expect(roots).toHaveLength(0);
    });

    it('getFilter returns current filter text', () => {
      expect(provider.getFilter()).toBe('');
      provider.setFilter('deploy');
      expect(provider.getFilter()).toBe('deploy');
    });

    it('is case-insensitive', () => {
      provider.setFilter('REVIEW');
      const roots = provider.getChildren();
      const skillGroup = roots.find((n) => n.kind === 'type' && n.type === 'skill');
      expect(skillGroup).toBeDefined();
    });
  });

  describe('sorting', () => {
    it('defaults to sorting by name', () => {
      expect(provider.getSortMode()).toBe('name');
    });

    it('sorts entries by name alphabetically', () => {
      provider.setSortMode('name');

      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      expect(skillGroup).toBeDefined();

      const sourceNodes = provider.getChildren(skillGroup!);
      const gstackSource = sourceNodes.find((n) => n.kind === 'source' && n.source === 'gstack');
      expect(gstackSource).toBeDefined();

      const entries = provider.getChildren(gstackSource!);
      const names = entries
        .filter((n): n is Extract<typeof n, { kind: 'entry' }> => n.kind === 'entry')
        .map((n) => n.entry.name);

      expect(names).toEqual(['qa', 'review']);
    });

    it('sorts entries by usage count descending', () => {
      provider.setSortMode('usage');

      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      const sourceNodes = provider.getChildren(skillGroup!);
      const gstackSource = sourceNodes.find((n) => n.kind === 'source' && n.source === 'gstack');
      const entries = provider.getChildren(gstackSource!);
      const usages = entries
        .filter((n): n is Extract<typeof n, { kind: 'entry' }> => n.kind === 'entry')
        .map((n) => n.entry.usageCount);

      expect(usages[0]).toBeGreaterThanOrEqual(usages[1]);
    });

    it('sorts entries by last modified descending', () => {
      provider.setSortMode('recent');

      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      const sourceNodes = provider.getChildren(skillGroup!);
      const gstackSource = sourceNodes.find((n) => n.kind === 'source' && n.source === 'gstack');
      const entries = provider.getChildren(gstackSource!);
      const dates = entries
        .filter((n): n is Extract<typeof n, { kind: 'entry' }> => n.kind === 'entry')
        .map((n) => n.entry.lastModified.getTime());

      expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
    });
  });

  describe('getTreeItem', () => {
    it('creates type group item with collapsed state', () => {
      const roots = provider.getChildren();
      const typeNode = roots[0];
      const item = provider.getTreeItem(typeNode);

      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(typeof item.label).toBe('string');
      expect(item.label as string).toContain('(');
    });

    it('creates entry item with contextValue "entry-favorited" for favorites', () => {
      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      const sourceNodes = provider.getChildren(skillGroup!);
      const gstackSource = sourceNodes.find((n) => n.kind === 'source' && n.source === 'gstack');
      const entries = provider.getChildren(gstackSource!);

      const favoritedEntry = entries.find((n) => n.kind === 'entry' && n.entry.favorite);
      expect(favoritedEntry).toBeDefined();

      const item = provider.getTreeItem(favoritedEntry!);
      expect(item.contextValue).toBe('entry-favorited');
    });

    it('creates entry item with contextValue "entry" for non-favorites', () => {
      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      const sourceNodes = provider.getChildren(skillGroup!);
      const gstackSource = sourceNodes.find((n) => n.kind === 'source' && n.source === 'gstack');
      const entries = provider.getChildren(gstackSource!);

      const nonFavEntry = entries.find((n) => n.kind === 'entry' && !n.entry.favorite);
      expect(nonFavEntry).toBeDefined();

      const item = provider.getTreeItem(nonFavEntry!);
      expect(item.contextValue).toBe('entry');
    });

    it('truncates long descriptions to 60 characters', () => {
      const longDescEntry: VaultEntry = {
        ...MOCK_ENTRIES[0],
        description: 'A'.repeat(80),
      };
      vault = createMockVault([longDescEntry]);
      provider = new EntriesProvider(vault as unknown as Vault);

      const roots = provider.getChildren();
      const sourceNodes = provider.getChildren(roots[0]);
      const entries = provider.getChildren(sourceNodes[0]);
      const item = provider.getTreeItem(entries[0]);

      expect((item.description as string).length).toBeLessThanOrEqual(60);
      expect((item.description as string).endsWith('...')).toBe(true);
    });

    it('sets command to open detail on entry items', () => {
      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      const sourceNodes = provider.getChildren(skillGroup!);
      const entries = provider.getChildren(sourceNodes[0]);
      const item = provider.getTreeItem(entries[0]);

      expect(item.command).toBeDefined();
      expect(item.command!.command).toBe('commandvault.openDetail');
    });

    it('creates source group item with folder icon', () => {
      const skillGroup = provider
        .getChildren()
        .find((n) => n.kind === 'type' && n.type === 'skill');
      const sourceNodes = provider.getChildren(skillGroup!);
      const item = provider.getTreeItem(sourceNodes[0]);

      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect(item.iconPath).toBeDefined();
    });
  });

  describe('refresh', () => {
    it('fires onDidChangeTreeData event', () => {
      let fired = false;
      provider.onDidChangeTreeData(() => {
        fired = true;
      });

      provider.refresh();
      expect(fired).toBe(true);
    });
  });
});
