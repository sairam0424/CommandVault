export type EntryType = 'skill' | 'agent' | 'command' | 'plugin' | 'rule' | 'hook';

export type EntrySource =
  | 'gstack'
  | 'bmad'
  | 'mindforge'
  | 'superpowers'
  | 'official'
  | 'community'
  | 'custom';

export type SearchTier = 'fuse' | 'minisearch' | 'sqlite';

export interface VaultEntry {
  readonly id: string;
  readonly name: string;
  readonly type: EntryType;
  readonly source: EntrySource;
  readonly description: string;
  readonly filePath: string;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly lastModified: Date;
  readonly favorite: boolean;
  readonly usageCount: number;
}

export interface VaultStats {
  readonly totalEntries: number;
  readonly byType: Readonly<Record<EntryType, number>>;
  readonly bySource: Readonly<Record<string, number>>;
  readonly favoriteCount: number;
  readonly lastScanAt: Date;
}

export interface SearchResult {
  readonly entry: VaultEntry;
  readonly score: number;
  readonly matchedFields: readonly string[];
}

export interface SearchOptions {
  readonly query: string;
  readonly type?: EntryType;
  readonly source?: EntrySource;
  readonly tags?: readonly string[];
  readonly favoritesOnly?: boolean;
  readonly limit?: number;
  readonly tier?: SearchTier;
}

export interface VaultConfig {
  readonly claudeConfigPath: string;
  readonly dbPath: string;
  readonly enableWatcher: boolean;
  readonly defaultSearchTier: SearchTier;
}

export interface ParsedFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly color?: string;
  readonly emoji?: string;
  readonly vibe?: string;
  readonly triggers?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly preambleTier?: number;
  readonly keywords?: readonly string[];
  readonly author?: string | { readonly name: string; readonly url?: string };
  readonly [key: string]: unknown;
}

export interface ParserResult {
  readonly entries: readonly VaultEntry[];
  readonly errors: readonly ParseError[];
}

export interface ParseError {
  readonly filePath: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface VaultEventMap {
  readonly 'entry:added': VaultEntry;
  readonly 'entry:updated': VaultEntry;
  readonly 'entry:removed': string;
  readonly 'scan:complete': VaultStats;
  readonly 'error': ParseError;
}

export type VaultEventHandler<K extends keyof VaultEventMap> = (
  data: VaultEventMap[K]
) => void;
