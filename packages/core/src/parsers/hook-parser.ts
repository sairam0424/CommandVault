import { basename, dirname } from 'node:path';
import type { VaultEntry, ParserResult, ParseError } from '../types/index.js';
import { generateStableId, getLastModified, safePath } from './utils.js';
import { FileTooLargeError, readBoundedText, skippedTooLarge } from './bounded-read.js';

interface HookDefinition {
  readonly type?: string;
  readonly command: string;
  readonly timeout?: number;
}

/**
 * Claude Code treats `matcher` as optional and an empty one like a missing one: the hook applies to
 * every match. Both resolve to this value so they read the same in names, tags and descriptions.
 */
const MATCH_ALL_MATCHER = '*';

/** Explicit non-empty matchers are kept verbatim; absent, non-string, empty or blank mean match-all. */
function resolveMatcher(matcher: unknown): string {
  return typeof matcher === 'string' && matcher.trim() !== '' ? matcher : MATCH_ALL_MATCHER;
}

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHookDefinition(hook: unknown): HookDefinition {
  if (!isRecord(hook) || typeof hook.command !== 'string') {
    throw new Error('hook must be an object with a string "command"');
  }
  return hook as unknown as HookDefinition;
}

async function buildHookEntry(
  event: HookEvent,
  matcher: string,
  hook: HookDefinition,
  allowedRoots: readonly string[],
  warnings: ParseError[],
): Promise<VaultEntry> {
  const commandParts = hook.command.split(' ');
  const scriptPath = commandParts.find((p: string) => p.endsWith('.js')) ?? hook.command;
  const scriptName = basename(scriptPath, '.js');
  const name = `${event}:${matcher}:${scriptName}`;

  let content = '';
  let lastModified = new Date();

  // Validate script path stays within allowed roots (path containment)
  const validatedPath = await safePath(scriptPath, allowedRoots);
  if (validatedPath) {
    try {
      content = await readBoundedText(validatedPath);
      lastModified = await getLastModified(validatedPath);
    } catch (err) {
      if (err instanceof FileTooLargeError) warnings.push(skippedTooLarge(err, 'hook script'));
      content = `// Script at: ${scriptPath}`;
    }
  } else {
    // Path escapes containment or doesn't exist — use command string as content
    content = `// Command: ${hook.command}`;
  }

  return {
    id: generateStableId('hook', name, 'custom'),
    name,
    type: 'hook',
    source: 'custom',
    description: `${event} hook on [${matcher}] → ${scriptName}`,
    filePath: scriptPath,
    tags: ['hook', event.toLowerCase(), matcher.toLowerCase()],
    metadata: {
      event,
      matcher,
      hookType: hook.type,
      command: hook.command,
      timeout: hook.timeout,
    },
    content,
    lastModified,
    favorite: false,
    usageCount: 0,
  };
}

export async function parseHooks(settingsPath: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  // Allowed roots for script path containment:
  // 1. The directory containing the settings file (e.g., ~/.claude/)
  // 2. The current working directory (for project-level hooks)
  const allowedRoots = [dirname(settingsPath), process.cwd()] as const;

  let settings: unknown;
  try {
    settings = JSON.parse(await readBoundedText(settingsPath));
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      return { entries: [], errors: [skippedTooLarge(err, 'settings file')] };
    }
    const message =
      err instanceof SyntaxError
        ? `Invalid JSON in settings file: ${err.message}`
        : 'Settings file not found or unreadable';
    return {
      entries: [],
      errors: [{ filePath: settingsPath, message, severity: 'error' }],
    };
  }

  if (!isRecord(settings)) {
    return {
      entries: [],
      errors: [
        {
          filePath: settingsPath,
          message: 'Settings file must contain a JSON object',
          severity: 'error',
        },
      ],
    };
  }

  const hooksByEvent = settings.hooks;
  if (!isRecord(hooksByEvent)) {
    return { entries, errors };
  }

  for (const event of HOOK_EVENTS) {
    const matchers = hooksByEvent[event];
    if (!Array.isArray(matchers)) continue;

    for (const matcherDef of matchers) {
      if (!isRecord(matcherDef) || !Array.isArray(matcherDef.hooks)) continue;
      const matcher = resolveMatcher(matcherDef.matcher);

      for (const hook of matcherDef.hooks as readonly unknown[]) {
        try {
          entries.push(
            await buildHookEntry(event, matcher, toHookDefinition(hook), allowedRoots, errors),
          );
        } catch (err) {
          errors.push({
            filePath: settingsPath,
            message: `Invalid ${event} hook on [${matcher}]: ${(err as Error).message}`,
            severity: 'error',
            cause: err,
          });
        }
      }
    }
  }

  return { entries, errors };
}
