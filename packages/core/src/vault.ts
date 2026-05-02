import { homedir } from 'node:os';
import { join } from 'node:path';
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
import {
  parseSkills,
  parseAgents,
  parseCommands,
  parsePlugins,
  parseRules,
  parseHooks,
  detectAgentConfigs,
} from './parsers/index.js';
import { SearchEngine } from './indexer/search-engine.js';
import { VaultWatcher, type WatcherCallback } from './watcher/index.js';
import { routePathToParser, type ParserType } from './watcher/path-router.js';

const DEFAULT_CLAUDE_PATH = join(homedir(), '.claude');
const DEFAULT_DB_DIR = join(homedir(), '.commandvault');
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'vault.db');

const DEBOUNCE_MS = 500;

export class Vault {
  private readonly config: VaultConfig;
  private searchEngine: SearchEngine | null = null;
  private readonly watcher: VaultWatcher;
  private entries: VaultEntry[] = [];
  private listeners: Map<string, Set<Function>> = new Map();
  private scanErrors: ParseError[] = [];
  private pendingChanges: Map<ParserType, Set<string>> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor(config?: Partial<VaultConfig>) {
    this.config = {
      claudeConfigPath: config?.claudeConfigPath ?? DEFAULT_CLAUDE_PATH,
      dbPath: config?.dbPath ?? DEFAULT_DB_PATH,
      enableWatcher: config?.enableWatcher ?? true,
      defaultSearchTier: config?.defaultSearchTier ?? 'minisearch',
    };

    this.watcher = new VaultWatcher(this.config.claudeConfigPath);
  }

  private getSearchEngine(): SearchEngine {
    if (!this.searchEngine) {
      throw new Error('Vault not initialized. Call initialize() first.');
    }
    return this.searchEngine;
  }

  async initialize(): Promise<VaultStats> {
    await mkdir(DEFAULT_DB_DIR, { recursive: true });
    this.searchEngine = await SearchEngine.create(
      this.config.dbPath,
      this.config.defaultSearchTier,
    );
    await this.scan();

    if (this.config.enableWatcher) {
      this.startWatcher();
    }

    return this.getStats();
  }

  async scan(): Promise<void> {
    const claudePath = this.config.claudeConfigPath;

    const results = await Promise.all([
      parseSkills(join(claudePath, 'skills')),
      parseAgents(join(claudePath, 'agents')),
      parseCommands(join(claudePath, 'commands')),
      parsePlugins(join(claudePath, 'plugins')),
      parseRules(join(claudePath, 'rules')),
      parseHooks(join(claudePath, 'settings.json')),
      detectAgentConfigs(process.cwd()),
    ]);

    const allEntries: VaultEntry[] = [];
    const allErrors: ParseError[] = [];

    for (const result of results) {
      allEntries.push(...result.entries);
      allErrors.push(...result.errors);
    }

    this.entries = allEntries;
    this.scanErrors = allErrors;
    this.getSearchEngine().index(allEntries);

    this.emit('scan:complete', this.getStats());

    for (const error of allErrors) {
      this.emit('error', error);
    }
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
        return ns ? `/${ns}:${entry.name.split(':').pop()}` : `/${entry.name}`;
      }
      case 'plugin':
        return `plugin:${entry.name}`;
      default:
        return entry.name;
    }
  }

  on<K extends keyof VaultEventMap>(event: K, handler: VaultEventHandler<K>): void {
    const key = event as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler);
  }

  off<K extends keyof VaultEventMap>(event: K, handler: VaultEventHandler<K>): void {
    this.listeners.get(event as string)?.delete(handler);
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

  private readonly parserFns: Readonly<Record<ParserType, () => Promise<ParserResult>>> = {
    skill: () => parseSkills(join(this.config.claudeConfigPath, 'skills')),
    agent: () => parseAgents(join(this.config.claudeConfigPath, 'agents')),
    command: () => parseCommands(join(this.config.claudeConfigPath, 'commands')),
    plugin: () => parsePlugins(join(this.config.claudeConfigPath, 'plugins')),
    rule: () => parseRules(join(this.config.claudeConfigPath, 'rules')),
    hook: () => parseHooks(join(this.config.claudeConfigPath, 'settings.json')),
  };

  async scanSingle(parserType: ParserType): Promise<void> {
    const result = await this.parserFns[parserType]();

    const kept = this.entries.filter((e) => e.type !== parserType);
    this.entries = [...kept, ...result.entries];

    const keptErrors = this.scanErrors.filter((e) => {
      const errorType = routePathToParser(e.filePath, this.config.claudeConfigPath);
      return errorType !== parserType;
    });
    this.scanErrors = [...keptErrors, ...result.errors];

    for (const error of result.errors) {
      this.emit('error', error);
    }

    this.getSearchEngine().index(this.entries);
    this.emit('scan:complete', this.getStats());
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

    const parserTypes = [...this.pendingChanges.keys()];
    this.pendingChanges.clear();

    const results = await Promise.all(parserTypes.map((pt) => this.parserFns[pt]()));

    const typesToReplace = new Set(parserTypes);
    const kept = this.entries.filter((e) => !typesToReplace.has(e.type as ParserType));
    const newEntries: VaultEntry[] = [];
    const newErrors: ParseError[] = [];

    for (const result of results) {
      newEntries.push(...result.entries);
      newErrors.push(...result.errors);
    }

    this.entries = [...kept, ...newEntries];
    const keptErrors = this.scanErrors.filter((e) => {
      const errorType = routePathToParser(e.filePath, this.config.claudeConfigPath);
      return !typesToReplace.has(errorType as ParserType);
    });
    this.scanErrors = [...keptErrors, ...newErrors];
    this.getSearchEngine().index(this.entries);
    this.emit('scan:complete', this.getStats());

    for (const error of newErrors) {
      this.emit('error', error);
    }
  }

  private emit<K extends keyof VaultEventMap>(event: K, data: VaultEventMap[K]): void {
    const handlers = this.listeners.get(event as string);
    if (handlers) {
      for (const handler of handlers) {
        (handler as VaultEventHandler<K>)(data);
      }
    }
  }
}

export function createVault(config?: Partial<VaultConfig>): Vault {
  return new Vault(config);
}
