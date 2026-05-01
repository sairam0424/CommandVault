export { Vault, createVault } from './vault.js';
export { SearchEngine } from './indexer/search-engine.js';
export { FuseEngine } from './indexer/fuse-engine.js';
export { MiniSearchEngine } from './indexer/minisearch-engine.js';
export { SqliteEngine } from './indexer/sqlite-engine.js';
export { VaultWatcher } from './watcher/index.js';
export {
  parseSkills,
  parseAgents,
  parseCommands,
  parsePlugins,
  parseRules,
  parseHooks,
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
  VaultEventMap,
  VaultEventHandler,
} from './types/index.js';
