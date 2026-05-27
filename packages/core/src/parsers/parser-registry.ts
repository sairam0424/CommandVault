import type { ParserResult } from '../types/index.js';

export interface ParserPlugin {
  readonly type: string;
  readonly displayName: string;
  readonly emoji: string;
  readonly color: string;
  readonly globPatterns: readonly string[];
  readonly parse: (dirPath: string) => Promise<ParserResult>;
  readonly parseSingle?: (filePath: string) => Promise<ParserResult>;
}

export class ParserRegistry {
  private readonly plugins: Map<string, ParserPlugin> = new Map();

  register(plugin: ParserPlugin): void {
    this.plugins.set(plugin.type, plugin);
  }

  getParser(type: string): ParserPlugin | undefined {
    return this.plugins.get(type);
  }

  getAllTypes(): readonly string[] {
    return [...this.plugins.keys()];
  }

  getAllPlugins(): readonly ParserPlugin[] {
    return [...this.plugins.values()];
  }
}

let defaultRegistry: ParserRegistry | null = null;

export function getDefaultRegistry(): ParserRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ParserRegistry();
  }
  return defaultRegistry;
}
