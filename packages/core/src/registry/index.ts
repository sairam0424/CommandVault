import { JsonRegistryAdapter } from './json-adapter.js';
import type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistryFailure,
  RegistryOptions,
  RegistrySearchOutcome,
  RegistrySearchResult,
} from './types.js';

export class RegistryManager {
  private readonly adapters: Map<string, RegistryAdapter> = new Map();
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions = {}) {
    this.options = options;
  }

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

  /**
   * Searches every registry. A registry that fails (unreachable, refused, malformed) is reported
   * in `failures` and never silently counted as "no results": the caller decides what an empty
   * answer means once it knows which registries actually answered.
   */
  async search(
    query: string,
    options?: { page?: number; limit?: number },
  ): Promise<RegistrySearchOutcome> {
    const limit = options?.limit ?? 20;
    const page = options?.page ?? 1;
    const adapters = [...this.adapters.values()];

    const settled = await Promise.allSettled(adapters.map((a) => a.search(query, options)));

    const results = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    const failures: readonly RegistryFailure[] = settled.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [{ registry: adapters[index]?.config.name ?? '', message: describe(outcome.reason) }]
        : [],
    );

    const allEntries = results.flatMap((r) => r.entries);
    const total = results.reduce((sum, r) => sum + r.total, 0);

    return {
      entries: allEntries.slice(0, limit),
      total,
      page,
      pageSize: limit,
      failures,
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
        return new JsonRegistryAdapter(config, this.options);
      default:
        return new JsonRegistryAdapter(config, this.options);
    }
  }
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export { JsonRegistryAdapter } from './json-adapter.js';
export type {
  RegistryAdapter,
  RegistryConfig,
  RegistryEntry,
  RegistryFailure,
  RegistryOptions,
  RegistrySearchOutcome,
  RegistrySearchResult,
} from './types.js';
