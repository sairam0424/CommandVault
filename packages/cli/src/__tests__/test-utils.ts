import { MOCK_ENTRIES, MOCK_STATS, mockSearchResults } from './fixtures/mock-vault.js';

export function createMockVault() {
  return {
    getAllEntries: () => MOCK_ENTRIES,
    getEntriesByType: (type: string) => MOCK_ENTRIES.filter((e) => e.type === type),
    search: (opts: { readonly query: string }) => mockSearchResults(opts.query),
    quickSearch: (query: string, limit = 20) => mockSearchResults(query).slice(0, limit),
    getStats: () => MOCK_STATS,
    getSlashCommand: (e: { readonly type: string; readonly name: string }) =>
      e.type === 'plugin' ? `plugin:${e.name}` : `/${e.name}`,
    toggleFavorite: async (_id: string) => true,
    recordUsage: (_id: string) => {},
    addEntries: async (entries: readonly unknown[]) => entries.length,
    dispose: async () => {},
    initialize: async () => MOCK_STATS,
  };
}
