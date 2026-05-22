import type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistrySearchResult,
} from './types.js';

export class JsonRegistryAdapter implements RegistryAdapter {
  readonly config: RegistryConfig;
  private cache: readonly RegistryEntry[] | null = null;
  private cacheExpiry = 0;
  private static readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  async search(
    query: string,
    options?: { page?: number; limit?: number },
  ): Promise<RegistrySearchResult> {
    const entries = await this.fetchEntries();
    const q = query.toLowerCase();
    const matched = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags?.some((t) => t.toLowerCase().includes(q)) ?? false),
    );
    return this.paginate(matched, options);
  }

  async getEntry(name: string): Promise<RegistryEntry | null> {
    const entries = await this.fetchEntries();
    return entries.find((e) => e.name === name) ?? null;
  }

  async list(options?: { page?: number; limit?: number }): Promise<RegistrySearchResult> {
    const entries = await this.fetchEntries();
    return this.paginate([...entries], options);
  }

  private async fetchEntries(): Promise<readonly RegistryEntry[]> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    const response = await fetch(this.config.url, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });

    if (!response.ok) {
      throw new Error(`Registry fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const raw: unknown[] = Array.isArray(data)
      ? data
      : (((data as Record<string, unknown>).entries as unknown[]) ?? []);

    const entries: readonly RegistryEntry[] = raw.map((e: unknown) => {
      const entry = e as Record<string, unknown>;
      return {
        name: String(entry.name ?? ''),
        description: String(entry.description ?? ''),
        type: String(entry.type ?? 'skill'),
        author: entry.author ? String(entry.author) : undefined,
        version: entry.version ? String(entry.version) : undefined,
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : undefined,
        downloads: typeof entry.downloads === 'number' ? entry.downloads : undefined,
        url: String(entry.url ?? ''),
        source: this.config.name,
      };
    });

    this.cache = entries;
    this.cacheExpiry = Date.now() + JsonRegistryAdapter.CACHE_TTL;

    return entries;
  }

  private paginate(
    entries: readonly RegistryEntry[],
    options?: { page?: number; limit?: number },
  ): RegistrySearchResult {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;
    const start = (page - 1) * limit;
    return {
      entries: entries.slice(start, start + limit),
      total: entries.length,
      page,
      pageSize: limit,
    };
  }
}
