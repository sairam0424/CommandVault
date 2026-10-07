export interface RegistryEntry {
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly author?: string;
  readonly version?: string;
  readonly tags?: readonly string[];
  readonly downloads?: number;
  readonly url: string;
  readonly source: string;
}

export interface RegistrySearchResult {
  readonly entries: readonly RegistryEntry[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** One registry whose adapter threw during a search; `message` is the adapter's own error text. */
export interface RegistryFailure {
  readonly registry: string;
  readonly message: string;
}

/** A search across every registry: the merged results plus every registry that failed. */
export type RegistrySearchOutcome = RegistrySearchResult & {
  readonly failures: readonly RegistryFailure[];
};

export interface RegistryConfig {
  readonly name: string;
  readonly url: string;
  readonly type: 'json' | 'api';
}

/** Settings shared by every adapter a manager creates. */
export interface RegistryOptions {
  /** Hosts whose private addresses the user accepts (config.json `allowPrivateHosts`). */
  readonly allowPrivateHosts?: readonly string[];
}

export interface RegistryAdapter {
  readonly config: RegistryConfig;
  search(query: string, options?: { page?: number; limit?: number }): Promise<RegistrySearchResult>;
  getEntry(name: string): Promise<RegistryEntry | null>;
  list(options?: { page?: number; limit?: number }): Promise<RegistrySearchResult>;
}
