import { z } from 'zod';
import type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistrySearchResult,
} from './types.js';

const RegistryEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  type: z.string().default('skill'),
  author: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  downloads: z.number().int().nonnegative().optional(),
  url: z.string().default(''),
});

const RegistryResponseSchema = z.union([
  z.array(RegistryEntrySchema),
  z.object({ entries: z.array(RegistryEntrySchema) }),
]);

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
    const parsed = RegistryResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Invalid registry response: ${parsed.error.message}`);
    }

    const raw = Array.isArray(parsed.data) ? parsed.data : parsed.data.entries;
    const entries: readonly RegistryEntry[] = raw.map((entry) => ({
      name: entry.name,
      description: entry.description,
      type: entry.type,
      author: entry.author,
      version: entry.version,
      tags: entry.tags,
      downloads: entry.downloads,
      url: entry.url,
      source: this.config.name,
    }));

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
