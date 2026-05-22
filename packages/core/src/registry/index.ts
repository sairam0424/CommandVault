import { JsonRegistryAdapter } from './json-adapter.js';
import type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistrySearchResult,
} from './types.js';

export class RegistryManager {
  private readonly adapters: Map<string, RegistryAdapter> = new Map();

  addRegistry(config: RegistryConfig): void {
    const adapter = this.createAdapter(config);
    this.adapters.set(config.name, adapter);
  }

  removeRegistry(name: string): boolean {
    return this.adapters.delete(name);
  }

  getRegistries(): readonly RegistryConfig[] {
    return [...this.adapters.values()].map((a) => a.config);
  }

  async search(
    query: string,
    options?: { page?: number; limit?: number },
  ): Promise<RegistrySearchResult> {
    const limit = options?.limit ?? 20;
    const page = options?.page ?? 1;

    const results = await Promise.all(
      [...this.adapters.values()].map((a) =>
        a.search(query, options).catch(
          (): RegistrySearchResult => ({
            entries: [],
            total: 0,
            page: 1,
            pageSize: limit,
          }),
        ),
      ),
    );

    const allEntries = results.flatMap((r) => r.entries);
    const total = results.reduce((sum, r) => sum + r.total, 0);

    return {
      entries: allEntries.slice(0, limit),
      total,
      page,
      pageSize: limit,
    };
  }

  async getEntry(registryName: string, entryName: string): Promise<RegistryEntry | null> {
    const adapter = this.adapters.get(registryName);
    if (!adapter) return null;
    return adapter.getEntry(entryName);
  }

  private createAdapter(config: RegistryConfig): RegistryAdapter {
    switch (config.type) {
      case 'json':
      case 'api':
        return new JsonRegistryAdapter(config);
      default:
        return new JsonRegistryAdapter(config);
    }
  }
}

export { JsonRegistryAdapter } from './json-adapter.js';
export type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistrySearchResult,
} from './types.js';
