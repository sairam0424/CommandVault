import { describe, it, expect, beforeEach } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { FavoritesProvider } from '../providers/favorites-provider';
import { createMockVault, MOCK_ENTRIES } from './fixtures/mock-entries';
import type { Vault, VaultEntry } from '@commandvault/core';

describe('FavoritesProvider', () => {
  let provider: FavoritesProvider;
  let vault: ReturnType<typeof createMockVault>;

  beforeEach(() => {
    vault = createMockVault();
    provider = new FavoritesProvider(vault as unknown as Vault);
  });

  describe('getChildren', () => {
    it('returns only favorited entries', () => {
      const children = provider.getChildren();
      const expectedFavorites = MOCK_ENTRIES.filter((e) => e.favorite);

      expect(children).toHaveLength(expectedFavorites.length);
      for (const child of children) {
        expect(child.favorite).toBe(true);
      }
    });

    it('returns empty array when no favorites exist', () => {
      const noFavorites = MOCK_ENTRIES.map((e) => ({ ...e, favorite: false }));
      vault = createMockVault(noFavorites);
      provider = new FavoritesProvider(vault as unknown as Vault);

      const children = provider.getChildren();
      expect(children).toHaveLength(0);
    });

    it('sorts alphabetically by name', () => {
      const children = provider.getChildren();
      const names = children.map((c) => c.name);

      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });
  });

  describe('getTreeItem', () => {
    it('contextValue is always entry-favorited', () => {
      const children = provider.getChildren();
      for (const entry of children) {
        const item = provider.getTreeItem(entry);
        expect(item.contextValue).toBe('entry-favorited');
      }
    });

    it('uses TreeItemCollapsibleState.None for leaf items', () => {
      const children = provider.getChildren();
      for (const entry of children) {
        const item = provider.getTreeItem(entry);
        expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
      }
    });

    it('shows type and source in description', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);

      expect(item.description).toContain(children[0].type);
      expect(item.description).toContain(children[0].source);
    });

    it('sets command to open detail', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);

      expect(item.command).toBeDefined();
      expect(item.command!.command).toBe('commandvault.openDetail');
      expect(item.command!.arguments).toContain(children[0]);
    });

    it('builds markdown tooltip with star icon', () => {
      const children = provider.getChildren();
      const item = provider.getTreeItem(children[0]);

      expect(item.tooltip).toBeDefined();
      expect((item.tooltip as { value: string }).value).toContain('$(star-full)');
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
