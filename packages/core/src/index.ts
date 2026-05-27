export { Vault, createVault } from './vault.js';
export { SearchEngine } from './indexer/search-engine.js';
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
  parseSingleFile,
  isSingleFileParseable,
} from './parsers/index.js';
export { parseMarkdownDir } from './parsers/base-parser.js';
export type { ParseConfig, ParseContext } from './parsers/base-parser.js';
export { ParserRegistry, getDefaultRegistry } from './parsers/parser-registry.js';
export type { ParserPlugin } from './parsers/parser-registry.js';
export { registerBuiltinParsers } from './parsers/builtin-registrations.js';
export { TYPE_EMOJIS, TYPE_COLORS, TYPE_LABELS, KNOWN_ENTRY_TYPES } from './constants.js';
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
export { getContentExcerpt } from './utils/excerpt.js';
export type { ContentExcerpt } from './utils/excerpt.js';
export { RegistryManager, JsonRegistryAdapter } from './registry/index.js';
export type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistrySearchResult,
} from './registry/types.js';
export { detectStaleness, type StalenessResult } from './indexer/staleness-detector.js';
export { scoreEntries, type QualityScore } from './indexer/quality-scorer.js';
