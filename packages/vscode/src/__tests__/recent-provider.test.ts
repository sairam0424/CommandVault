import { describe, it, expect, beforeEach } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { RecentProvider } from '../providers/recent-provider';
import { createMockVault, MOCK_ENTRIES } from './fixtures/mock-entries';
import type { Vault, VaultEntry } from '@commandvault/core';

describe('RecentProvider', () => {
  let provider: RecentProvider;
  let vault: ReturnType<typeof createMockVault>;

  beforeEach(() => {
    vault = createMockVault();
    provider = new RecentProvider(vault as unknown as Vault);
  });

  describe('getChildren', () => {
    it('returns only entries with usageCount > 0', () => {
      const children = provider.getChildren();
      const expectedUsed = MOCK_ENTRIES.filter((e) => e.usageCount > 0);

      expect(children).toHaveLength(expectedUsed.length);
      for (const child of children) {
        expect(child.usageCount).toBeGreaterThan(0);
      }
    });

    it('sorts by usageCount descending', () => {
      const children = provider.getChildren();
      const usages = children.map((c) => c.usageCount);

      for (let i = 1; i < usages.length; i++) {
        expect(usages[i - 1]).toBeGreaterThanOrEqual(usages[i]);
      }
    });

    it('limits to 20 entries', () => {
      const manyEntries: VaultEntry[] = Array.from({ length: 30 }, (_, i) => ({
        ...MOCK_ENTRIES[0],
        id: `entry-${i}`,
        name: `entry-${i}`,
        usageCount: 30 - i,
      }));
      vault = createMockVault(manyEntries);
      provider = new RecentProvider(vault as unknown as Vault);

      const children = provider.getChildren();
      expect(children).toHaveLength(20);
    });

    it('returns empty array when no entries have usage', () => {
      const noUsage = MOCK_ENTRIES.map((e) => ({ ...e, usageCount: 0 }));
      vault = createMockVault(noUsage);
      provider = new RecentProvider(vault as unknown as Vault);

      const children = provider.getChildren();
      expect(children).toHaveLength(0);
    });
  });

  describe('getTreeItem', () => {
    it('shows usage count in description', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);

      expect(item.description).toContain(`used ${children[0].usageCount}x`);
    });

    it('uses TreeItemCollapsibleState.None', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);
      expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    });

    it('sets contextValue based on favorite status', () => {
      const children = provider.getChildren();

      const favEntry = children.find((e) => e.favorite);
      if (favEntry) {
        const item = provider.getTreeItem(favEntry);
        expect(item.contextValue).toBe('entry-favorited');
      }

      const nonFavEntry = children.find((e) => !e.favorite);
      if (nonFavEntry) {
        const item = provider.getTreeItem(nonFavEntry);
        expect(item.contextValue).toBe('entry');
      }
    });

    it('sets command to open detail', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);

      expect(item.command).toBeDefined();
      expect(item.command!.command).toBe('commandvault.openDetail');
    });

    it('builds markdown tooltip with usage info', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);

      expect(item.tooltip).toBeDefined();
      expect((item.tooltip as { value: string }).value).toContain('Used:');
      expect((item.tooltip as { value: string }).value).toContain('times');
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
