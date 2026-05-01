import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SearchTier } from '@commandvault/core';

const CONFIG_PATH = join(homedir(), '.commandvault', 'config.json');

const VALID_TIERS: ReadonlySet<string> = new Set(['fuse', 'minisearch', 'sqlite']);

export interface CliConfig {
  readonly claudeConfigPath?: string;
  readonly searchTier?: SearchTier;
  readonly enableWatcher?: boolean;
}

export async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      claudeConfigPath:
        typeof parsed.claudeConfigPath === 'string' && parsed.claudeConfigPath
          ? parsed.claudeConfigPath.replace(/^~/, homedir())
          : undefined,
      searchTier:
        typeof parsed.searchTier === 'string' && VALID_TIERS.has(parsed.searchTier)
          ? (parsed.searchTier as SearchTier)
          : undefined,
      enableWatcher:
        typeof parsed.enableWatcher === 'boolean' ? parsed.enableWatcher : undefined,
    };
  } catch {
    return {};
  }
}
