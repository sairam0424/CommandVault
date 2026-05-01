import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateId, getLastModified } from './utils.js';

interface HookDefinition {
  readonly type: string;
  readonly command: string;
  readonly timeout?: number;
}

interface HookMatcher {
  readonly matcher: string;
  readonly hooks: readonly HookDefinition[];
}

interface SettingsJson {
  readonly hooks?: {
    readonly PreToolUse?: readonly HookMatcher[];
    readonly PostToolUse?: readonly HookMatcher[];
    readonly Stop?: readonly HookMatcher[];
  };
}

export async function parseHooks(settingsPath: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let settings: SettingsJson;
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      errors: [{ filePath: settingsPath, message: 'Settings file not found' }],
    };
  }

  if (!settings.hooks) {
    return { entries, errors };
  }

  const hookEvents = ['PreToolUse', 'PostToolUse', 'Stop'] as const;

  for (const event of hookEvents) {
    const matchers = settings.hooks[event];
    if (!matchers) continue;

    for (const matcherDef of matchers) {
      for (const hook of matcherDef.hooks) {
        const commandParts = hook.command.split(' ');
        const scriptPath = commandParts.find((p) => p.endsWith('.js')) ?? hook.command;
        const scriptName = basename(scriptPath, '.js');
        const name = `${event}:${matcherDef.matcher}:${scriptName}`;

        let content = '';
        let lastModified = new Date();
        try {
          content = await readFile(scriptPath, 'utf-8');
          lastModified = await getLastModified(scriptPath);
        } catch {
          content = `// Script at: ${scriptPath}`;
        }

        const entry: VaultEntry = {
          id: generateId(`${settingsPath}:${name}`),
          name,
          type: 'hook',
          source: 'custom',
          description: `${event} hook on [${matcherDef.matcher}] → ${scriptName}`,
          filePath: scriptPath,
          tags: ['hook', event.toLowerCase(), matcherDef.matcher.toLowerCase()],
          metadata: {
            event,
            matcher: matcherDef.matcher,
            hookType: hook.type,
            command: hook.command,
            timeout: hook.timeout,
          },
          content,
          lastModified,
          favorite: false,
          usageCount: 0,
        };
        entries.push(entry);
      }
    }
  }

  return { entries, errors };
}
