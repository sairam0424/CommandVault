import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateStableId, getLastModified, safePath } from './utils.js';

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

  // Allowed roots for script path containment:
  // 1. The directory containing the settings file (e.g., ~/.claude/)
  // 2. The current working directory (for project-level hooks)
  const allowedRoots = [dirname(settingsPath), process.cwd()] as const;

  let settings: SettingsJson;
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch (err) {
    const message =
      err instanceof SyntaxError
        ? `Invalid JSON in settings file: ${err.message}`
        : 'Settings file not found or unreadable';
    return {
      entries: [],
      errors: [{ filePath: settingsPath, message }],
    };
  }

  if (!settings.hooks) {
    return { entries, errors };
  }

  const hookEvents = ['PreToolUse', 'PostToolUse', 'Stop'] as const;

  for (const event of hookEvents) {
    const matchers = settings.hooks[event];
    if (!matchers || !Array.isArray(matchers)) continue;

    for (const matcherDef of matchers) {
      if (!matcherDef?.hooks || !Array.isArray(matcherDef.hooks)) continue;
      for (const hook of matcherDef.hooks as readonly HookDefinition[]) {
        const commandParts = hook.command.split(' ');
        const scriptPath = commandParts.find((p: string) => p.endsWith('.js')) ?? hook.command;
        const scriptName = basename(scriptPath, '.js');
        const name = `${event}:${matcherDef.matcher}:${scriptName}`;

        let content = '';
        let lastModified = new Date();

        // Validate script path stays within allowed roots (path containment)
        const validatedPath = await safePath(scriptPath, allowedRoots);
        if (validatedPath) {
          try {
            content = await readFile(validatedPath, 'utf-8');
            lastModified = await getLastModified(validatedPath);
          } catch {
            content = `// Script at: ${scriptPath}`;
          }
        } else {
          // Path escapes containment or doesn't exist — use command string as content
          content = `// Command: ${hook.command}`;
        }

        const entry: VaultEntry = {
          id: generateStableId('hook', name, 'custom'),
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
