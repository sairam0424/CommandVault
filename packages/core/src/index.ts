export { Vault, createVault } from './vault.js';
export { SearchEngine } from './indexer/search-engine.js';
export { FuseEngine } from './indexer/fuse-engine.js';
export { MiniSearchEngine } from './indexer/minisearch-engine.js';
export { SqliteEngine } from './indexer/sqlite-engine.js';
export { normalizeScore } from './indexer/normalizer.js';
export { VaultWatcher } from './watcher/index.js';
export { exportEntries, exportToFile, importFromFile, importFromUrl } from './sync/index.js';
export type { VaultExportBundle, ExportedEntry } from './sync/index.js';
export {
  parseSkills,
  parseAgents,
  parseCommands,
  parsePlugins,
  parseRules,
  parseHooks,
  detectAgentConfigs,
  withRetry,
} from './parsers/index.js';
export type {
  VaultEntry,
  VaultStats,
  VaultConfig,
  SearchResult,
  SearchOptions,
  SearchTier,
  EntryType,
  EntrySource,
  ParsedFrontmatter,
  ParserResult,
  ParseError,
  RankingWeights,
  VaultEventMap,
  VaultEventHandler,
} from './types/index.js';
