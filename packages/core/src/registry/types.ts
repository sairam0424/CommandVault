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

export interface RegistryConfig {
  readonly name: string;
  readonly url: string;
  readonly type: 'json' | 'api';
}

export interface RegistryAdapter {
  readonly config: RegistryConfig;
  search(query: string, options?: { page?: number; limit?: number }): Promise<RegistrySearchResult>;
  getEntry(name: string): Promise<RegistryEntry | null>;
  list(options?: { page?: number; limit?: number }): Promise<RegistrySearchResult>;
}
