export type EntryType = 'skill' | 'agent' | 'command' | 'plugin' | 'rule' | 'hook';

export type EntrySource =
  | 'gstack'
  | 'bmad'
  | 'mindforge'
  | 'superpowers'
  | 'official'
  | 'community'
  | 'custom'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'aider'
  | 'continue';

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

export interface RankingWeights {
  readonly textRelevance: number;
  readonly recency: number;
  readonly usageFrequency: number;
  readonly favoriteBoost: number;
}

export interface SearchOptions {
  readonly query: string;
  readonly type?: EntryType;
  readonly source?: EntrySource;
  readonly tags?: readonly string[];
  readonly favoritesOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly modifiedAfter?: Date;
  readonly modifiedBefore?: Date;
  readonly tier?: SearchTier;
  readonly weights?: Partial<RankingWeights>;
}

export interface VaultConfig {
  readonly claudeConfigPath: string;
  readonly dbPath: string;
  readonly enableWatcher: boolean;
  readonly defaultSearchTier: SearchTier;
  /**
   * A project directory whose agent configs (CLAUDE.md, .claude/, .cursor/rules, .cursorrules,
   * .github/copilot-instructions.md, .windsurfrules, .windsurf/rules, .aider.conf.yml) are indexed
   * next to the Claude config directory. Omitted means no project scan at all: nothing is read
   * from the current directory. The account-level configs under the home directory
   * (~/.aider.conf.yml, ~/.continue/config.json) are indexed either way.
   *
   * It is also where a relative script named by a hook in settings.json is looked for, before the
   * directory holding settings.json. Without it only that directory is: never the current one.
   *
   * A relative path is resolved when the vault is created. A path that is empty, missing or not a
   * directory is reported by every scan as an "agent-configs" ParseError with severity "error".
   */
  readonly projectRoot?: string;
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

/**
 * - error: the file or record could not be used, or a parser failed.
 * - warning: something was indexed or skipped on purpose and is worth surfacing, not alarming
 *   (a frontmatter recovery, a dropped duplicate id, a file over the read limit).
 */
export type ParseSeverity = 'error' | 'warning';

export interface ParseError {
  readonly filePath: string;
  readonly message: string;
  /** Absent means "error"; use `getParseSeverity` to read it. Built-in parsers always set it. */
  readonly severity?: ParseSeverity;
  readonly cause?: unknown;
  /**
   * Parser the error is attributed to, when the path alone cannot say: a registered parser's type
   * (built-in entry types and plugin parser types), "agent-configs" (agent-config detection: the
   * project directory, when one is set, and the home-level configs), or "import"
   * (Vault.addEntries). A duplicate-id error carries the losing entry's type.
   * `runParserSafely` fills it in for any problem a parser reports without one.
   */
  readonly parser?: string;
}

export interface VaultEventMap {
  readonly 'entry:added': VaultEntry;
  readonly 'entry:updated': VaultEntry;
  readonly 'entry:removed': string;
  readonly 'scan:complete': VaultStats;
  readonly error: ParseError;
}

export type VaultEventHandler<K extends keyof VaultEventMap> = (data: VaultEventMap[K]) => void;
