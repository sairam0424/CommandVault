import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  VaultEntry,
  VaultConfig,
  VaultStats,
  SearchResult,
  SearchOptions,
  SearchTier,
  VaultEventMap,
  VaultEventHandler,
  ParserResult,
  ParseError,
} from './types/index.js';
import { resolveClaudeDir, resolveDataDir } from './paths.js';
import {
  AGENT_CONFIG_PARSER,
  parseHooks,
  resolveProjectRoot,
  withAgentConfigs,
} from './parsers/index.js';
import { ParserRegistry, getDefaultRegistry, registerBuiltinParsers } from './parsers/index.js';
import { parseSingleFile, isSingleFileParseable } from './parsers/single-file-parser.js';
import { SearchEngine } from './indexer/search-engine.js';
import { VaultWatcher, type WatcherCallback } from './watcher/index.js';
import { routePathToParser, type ParserType } from './watcher/path-router.js';
import {
  dedupeEntriesById,
  hasDuplicateIdError,
  partitionValidEntries,
  runParserSafely,
} from './scan-pipeline.js';

const DB_FILE_NAME = 'vault.db';
const PRIVATE_DIR_MODE = 0o700;

const DEBOUNCE_MS = 500;
const IMPORT_PARSER = 'import';

export class Vault {
  private readonly config: VaultConfig;
  private searchEngine: SearchEngine | null = null;
  private readonly watcher: VaultWatcher;
  private readonly registry: ParserRegistry;
  private entries: VaultEntry[] = [];
  private listeners: Map<keyof VaultEventMap, Set<VaultEventHandler<keyof VaultEventMap>>> =
    new Map();
  private scanErrors: ParseError[] = [];
  private pendingChanges: Map<ParserType, Set<string>> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private scanLock: Promise<void> = Promise.resolve();

  constructor(config?: Partial<VaultConfig>) {
    this.config = {
      claudeConfigPath: config?.claudeConfigPath ?? resolveClaudeDir(),
      dbPath: config?.dbPath ?? join(resolveDataDir(), DB_FILE_NAME),
      enableWatcher: config?.enableWatcher ?? true,
      defaultSearchTier: config?.defaultSearchTier ?? 'minisearch',
      projectRoot: config?.projectRoot && resolveProjectRoot(config.projectRoot),
    };

    this.registry = getDefaultRegistry();
    registerBuiltinParsers(this.registry);
    this.watcher = new VaultWatcher(this.config.claudeConfigPath);
  }

  getRegistry(): ParserRegistry {
    return this.registry;
  }

  private getSearchEngine(): SearchEngine {
    if (!this.searchEngine) {
      throw new Error('Vault not initialized. Call initialize() first.');
    }
    return this.searchEngine;
  }

  private withScanLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.scanLock;
    let resolve!: () => void;
    this.scanLock = new Promise<void>((r) => {
      resolve = r;
    });
    return prev.then(fn).finally(() => resolve());
  }

  async initialize(): Promise<VaultStats> {
    await mkdir(dirname(this.config.dbPath), { recursive: true, mode: PRIVATE_DIR_MODE });
    this.searchEngine = await SearchEngine.create(
      this.config.dbPath,
      this.config.defaultSearchTier,
    );

    try {
      await this.scan();
    } catch (err) {
      this.searchEngine.close();
      this.searchEngine = null;
      throw err;
    }

    if (this.config.enableWatcher) {
      this.startWatcher();
    }

    return this.getStats();
  }

  private getParserPath(type: string): string {
    const claudePath = this.config.claudeConfigPath;
    if (type === 'hook') return join(claudePath, 'settings.json');
    return join(claudePath, `${type}s`);
  }

  /** Reads one entry type. Rules are read together with the agent configs, which are rules too. */
  private getParserFn(parserType: string): () => Promise<ParserResult> {
    const plugin = this.registry.getParser(parserType);
    if (!plugin) {
      return () => Promise.resolve({ entries: [], errors: [] });
    }
    const path = this.getParserPath(parserType);
    // The built-in hook parser reads the scripts hooks name, relative to the project directory
    // when one is given. Any other parser, including a replacement for it, is called as registered.
    const parsePath =
      plugin.parse === parseHooks
        ? (settingsPath: string) =>
            parseHooks(settingsPath, { projectRoot: this.config.projectRoot })
        : plugin.parse;
    const parse = () => runParserSafely(parserType, path, () => parsePath(path));
    return parserType === 'rule' ? () => withAgentConfigs(parse, this.config.projectRoot) : parse;
  }

  /** The parser an error belongs to: its explicit tag, else the parser that owns its file path. */
  private errorParser(error: ParseError): string | null {
    const parser = error.parser ?? routePathToParser(error.filePath, this.config.claudeConfigPath);
    return parser === AGENT_CONFIG_PARSER ? 'rule' : parser;
  }

  async scan(): Promise<void> {
    return this.withScanLock(async () => {
      const oldEntries = [...this.entries];

      const results = await Promise.all(
        this.registry.getAllTypes().map((type) => this.getParserFn(type)()),
      );
      const unique = dedupeEntriesById(results.flatMap((result) => result.entries));
      const allErrors: ParseError[] = [
        ...results.flatMap((result) => result.errors),
        ...unique.errors,
      ];

      this.entries = [...unique.entries].sort((a, b) => a.id.localeCompare(b.id));
      this.scanErrors = allErrors;
      this.getSearchEngine().index(this.entries);

      const isFirstScan = oldEntries.length === 0;
      if (!isFirstScan) {
        this.diffAndEmit(oldEntries, this.entries);
      }
      this.emit('scan:complete', this.getStats());

      for (const error of allErrors) {
        this.emit('error', error);
      }
    });
  }

  search(options: SearchOptions): SearchResult[] {
    return this.getSearchEngine().search(options);
  }

  quickSearch(query: string, limit = 20): SearchResult[] {
    return this.getSearchEngine().search({ query, limit, tier: 'fuse' });
  }

  suggest(query: string, limit = 10): string[] {
    return this.getSearchEngine().suggest(query, limit);
  }

  getAllEntries(): readonly VaultEntry[] {
    return this.entries;
  }

  getEntriesByType(type: VaultEntry['type']): readonly VaultEntry[] {
    return this.entries.filter((e) => e.type === type);
  }

  getEntriesBySource(source: VaultEntry['source']): readonly VaultEntry[] {
    return this.entries.filter((e) => e.source === source);
  }

  getEntry(id: string): VaultEntry | undefined {
    return this.getSearchEngine().getEntry(id) ?? this.entries.find((e) => e.id === id);
  }

  toggleFavorite(id: string): boolean {
    return this.getSearchEngine().toggleFavorite(id);
  }

  recordUsage(id: string): void {
    this.getSearchEngine().incrementUsage(id);
  }

  getStats(): VaultStats {
    return this.getSearchEngine().getStats();
  }

  addTag(id: string, tag: string): void {
    this.getSearchEngine().addTag(id, tag);
  }

  removeTag(id: string, tag: string): void {
    this.getSearchEngine().removeTag(id, tag);
  }

  async toggleFavorites(ids: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    return this.withScanLock(async () => {
      const results = new Map<string, boolean>();
      const engine = this.getSearchEngine();
      for (const id of ids) {
        results.set(id, engine.toggleFavorite(id));
      }
      engine.clearCache();
      return results;
    });
  }

  async addTags(ids: readonly string[], tags: readonly string[]): Promise<void> {
    return this.withScanLock(async () => {
      const engine = this.getSearchEngine();
      for (const id of ids) {
        for (const tag of tags) {
          engine.addTag(id, tag);
        }
      }
      engine.clearCache();
    });
  }

  async removeTags(ids: readonly string[], tags: readonly string[]): Promise<void> {
    return this.withScanLock(async () => {
      const engine = this.getSearchEngine();
      for (const id of ids) {
        for (const tag of tags) {
          engine.removeTag(id, tag);
        }
      }
      engine.clearCache();
    });
  }

  getTagsForEntry(id: string): string[] {
    return this.getSearchEngine().getTagsForEntry(id);
  }

  saveSnapshot(): void {
    this.getSearchEngine().saveSnapshot(this.entries);
  }

  getDiff(): { added: VaultEntry[]; removed: string[]; modified: VaultEntry[] } {
    return this.getSearchEngine().getDiff(this.entries);
  }

  getErrors(): readonly ParseError[] {
    return this.scanErrors;
  }

  getSlashCommand(entry: VaultEntry): string {
    switch (entry.type) {
      case 'skill':
        return `/${entry.name}`;
      case 'command': {
        const ns = entry.metadata.namespace as string | undefined;
        if (!ns) return `/${entry.name}`;
        if (entry.name.startsWith(`${ns}:`)) return `/${entry.name}`;
        return `/${ns}:${entry.name}`;
      }
      case 'plugin':
        return `plugin:${entry.name}`;
      default:
        return entry.name;
    }
  }

  /**
   * Adds imported records to the vault and returns how many of them ended up in it. Records that
   * fail validation are reported as "import" ParseErrors. Ids stay unique: when an imported record
   * shares an id with an existing entry, the one whose filePath sorts first wins. An import that
   * sorts first therefore replaces the existing (e.g. scanned) entry, which is dropped and reported
   * only as a "duplicate id" ParseError; the return value counts the import, not the replacement.
   * An import that loses is reported the same way and is not counted.
   */
  async addEntries(newEntries: readonly VaultEntry[]): Promise<number> {
    return this.withScanLock(async () => {
      const { valid, errors: rejected } = partitionValidEntries(newEntries, IMPORT_PARSER);
      const unique = dedupeEntriesById([...this.entries, ...valid]);
      const survivors = new Set<VaultEntry>(unique.entries);
      const accepted = valid.filter((entry) => survivors.has(entry)).length;

      const errors = [...rejected, ...unique.errors];
      this.scanErrors = [...this.scanErrors, ...errors];

      if (accepted > 0) {
        const oldEntries = [...this.entries];
        this.entries = unique.entries;
        this.getSearchEngine().index(this.entries);
        this.diffAndEmit(oldEntries, this.entries);
        this.emit('scan:complete', this.getStats());
      }

      for (const error of errors) {
        this.emit('error', error);
      }
      return accepted;
    });
  }

  on<K extends keyof VaultEventMap>(event: K, handler: VaultEventHandler<K>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as VaultEventHandler<keyof VaultEventMap>);
  }

  off<K extends keyof VaultEventMap>(event: K, handler: VaultEventHandler<K>): void {
    this.listeners.get(event)?.delete(handler as VaultEventHandler<keyof VaultEventMap>);
  }

  async dispose(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.flushPromise) {
      await this.flushPromise;
    }
    await this.flushPendingChanges();
    await this.watcher.stop();
    this.searchEngine?.close();
    this.listeners.clear();
  }

  async scanSingle(parserType: ParserType): Promise<void> {
    return this.withScanLock(async () => {
      const result = await this.getParserFn(parserType)();

      const kept = this.entries.filter((e) => e.type !== parserType);
      const unique = dedupeEntriesById([...kept, ...result.entries]);
      this.entries = unique.entries;

      const keptErrors = this.scanErrors.filter((e) => this.errorParser(e) !== parserType);
      const newErrors = [...result.errors, ...unique.errors];
      this.scanErrors = [...keptErrors, ...newErrors];

      for (const error of newErrors) {
        this.emit('error', error);
      }

      this.getSearchEngine().index(this.entries);
      this.emit('scan:complete', this.getStats());
    });
  }

  private startWatcher(): void {
    const callback: WatcherCallback = (_event, changedPath) => {
      const parserType = routePathToParser(changedPath, this.config.claudeConfigPath);

      if (parserType) {
        const paths = this.pendingChanges.get(parserType) ?? new Set();
        paths.add(changedPath);
        this.pendingChanges.set(parserType, paths);
      } else {
        return;
      }

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.flushPromise = this.flushPendingChanges()
          .catch((err) => {
            this.emit('error', { filePath: '', message: `Re-scan failed: ${err}` });
          })
          .finally(() => {
            this.flushPromise = null;
          });
      }, DEBOUNCE_MS);
    };

    this.watcher.start(callback);
  }

  private async flushPendingChanges(): Promise<void> {
    if (this.pendingChanges.size === 0) return;

    return this.withScanLock(async () => {
      const oldEntries = [...this.entries];
      const snapshot = new Map(this.pendingChanges);
      this.pendingChanges.clear();

      const singleFileTypes: ParserType[] = [];
      const fullReparseTypes: ParserType[] = [];

      for (const [parserType, paths] of snapshot) {
        // A type with a dropped duplicate must be re-read in full: the loser is no longer in
        // this.entries, so a single-file update cannot bring it back when the winner goes away.
        const canUpdateOneFile =
          paths.size === 1 &&
          isSingleFileParseable(parserType) &&
          !hasDuplicateIdError(this.scanErrors, parserType);
        (canUpdateOneFile ? singleFileTypes : fullReparseTypes).push(parserType);
      }

      for (const parserType of singleFileTypes) {
        await this.applySingleFileChange([...snapshot.get(parserType)!][0], parserType);
      }
      const reparseErrors = await this.applyFullReparse(fullReparseTypes);

      const unique = dedupeEntriesById(this.entries);
      this.entries = unique.entries;
      this.scanErrors = [...this.scanErrors, ...unique.errors];
      for (const error of [...reparseErrors, ...unique.errors]) {
        this.emit('error', error);
      }

      this.getSearchEngine().index(this.entries);
      this.diffAndEmit(oldEntries, this.entries);
      this.emit('scan:complete', this.getStats());
    });
  }

  private async applySingleFileChange(filePath: string, parserType: ParserType): Promise<void> {
    const entry = await parseSingleFile(filePath, parserType);
    if (entry) {
      const existed = this.entries.some((e) => e.filePath === filePath);
      this.entries = existed
        ? this.entries.map((e) => (e.filePath === filePath ? entry : e))
        : [...this.entries, entry];
    } else {
      this.entries = this.entries.filter((e) => e.filePath !== filePath);
    }
    this.scanErrors = this.scanErrors.filter((e) => e.filePath !== filePath);
  }

  /** Re-reads whole parser types, replacing their entries and errors. Returns the new errors. */
  private async applyFullReparse(parserTypes: readonly ParserType[]): Promise<ParseError[]> {
    if (parserTypes.length === 0) return [];

    const results = await Promise.all(parserTypes.map((pt) => this.getParserFn(pt)()));
    const typesToReplace = new Set<string>(parserTypes);
    const newErrors = results.flatMap((result) => result.errors);

    this.entries = [
      ...this.entries.filter((e) => !typesToReplace.has(e.type)),
      ...results.flatMap((result) => result.entries),
    ];
    const keptErrors = this.scanErrors.filter((e) => {
      const owner = this.errorParser(e);
      return owner === null || !typesToReplace.has(owner);
    });
    this.scanErrors = [...keptErrors, ...newErrors];
    return newErrors;
  }

  private diffAndEmit(oldEntries: readonly VaultEntry[], newEntries: readonly VaultEntry[]): void {
    const oldMap = new Map(oldEntries.map((e) => [e.id, e]));
    const newMap = new Map(newEntries.map((e) => [e.id, e]));

    for (const [id, entry] of newMap) {
      const old = oldMap.get(id);
      if (!old) {
        this.emit('entry:added', entry);
      } else if (old.content !== entry.content || old.description !== entry.description) {
        this.emit('entry:updated', entry);
      }
    }

    for (const [id] of oldMap) {
      if (!newMap.has(id)) {
        this.emit('entry:removed', id);
      }
    }
  }

  private emit<K extends keyof VaultEventMap>(event: K, data: VaultEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          (handler as VaultEventHandler<K>)(data);
        } catch {
          // Isolate handler errors — one failing listener shouldn't break others
        }
      }
    }
  }
}

export function createVault(config?: Partial<VaultConfig>): Vault {
  return new Vault(config);
}
