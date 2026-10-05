import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
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

/** Where `parseHooks` may look for the scripts a hook command names. */
export interface HookParseOptions {
  /**
   * An absolute project directory the hooks run in, possibly spelled through a symlink. Relative
   * scripts are looked for here first, and scripts inside it are readable. Omitted (or blank) means
   * the settings file's own directory is the only root. The current directory is never one: the
   * entries must not change with the directory a scan happens to run from.
   */
  readonly projectRoot?: string;
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

/**
 * The script's real path when it exists inside one of the roots. A relative path is tried against
 * each root in turn, in order: `realpath` on the bare string would resolve it against the current
 * directory.
 */
async function findContainedScript(
  scriptPath: string,
  roots: readonly string[],
): Promise<string | null> {
  const candidates = isAbsolute(scriptPath)
    ? [scriptPath]
    : roots.map((r) => resolve(r, scriptPath));
  for (const candidate of candidates) {
    const validated = await safePath(candidate, roots);
    if (validated) return validated;
  }
  return null;
}

async function buildHookEntry(
  event: HookEvent,
  matcher: string,
  hook: HookDefinition,
  roots: readonly string[],
  warnings: ParseError[],
): Promise<VaultEntry> {
  const commandParts = hook.command.split(' ');
  const scriptPath = commandParts.find((p: string) => p.endsWith('.js')) ?? hook.command;
  const scriptName = basename(scriptPath, '.js');
  const name = `${event}:${matcher}:${scriptName}`;

  let content = '';
  let lastModified = new Date();

  // Validate script path stays within the roots (path containment)
  const validatedPath = await findContainedScript(scriptPath, roots);
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

/**
 * Roots for script lookup and containment, in lookup order: the explicit project directory, when
 * there is one (hooks run there), then the directory containing the settings file (e.g. ~/.claude/).
 */
function scriptRoots(settingsPath: string, options: HookParseOptions): readonly string[] {
  const settingsDir = dirname(settingsPath);
  const projectRoot = options.projectRoot?.trim() ? options.projectRoot : null;
  return projectRoot === null ? [settingsDir] : [projectRoot, settingsDir];
}

/**
 * The roots as the file system spells them. `safePath` compares a script's real path with the
 * root, so a root reached through a symlink (macOS /tmp and /var, a linked workspace or home
 * directory, an editor folder that is not canonical) would contain no script at all and every hook
 * would quietly fall back to its command string. A root that cannot be resolved stays as given: it
 * cannot contain a script either way, which is `safePath`'s own answer for a path it cannot resolve.
 */
async function canonicalRoots(roots: readonly string[]): Promise<readonly string[]> {
  return Promise.all(roots.map((root) => realpath(root).catch(() => root)));
}

export async function parseHooks(
  settingsPath: string,
  options: HookParseOptions = {},
): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

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

  const roots = await canonicalRoots(scriptRoots(settingsPath, options));

  for (const event of HOOK_EVENTS) {
    const matchers = hooksByEvent[event];
    if (!Array.isArray(matchers)) continue;

    for (const matcherDef of matchers) {
      if (!isRecord(matcherDef) || !Array.isArray(matcherDef.hooks)) continue;
      const matcher = resolveMatcher(matcherDef.matcher);

      for (const hook of matcherDef.hooks as readonly unknown[]) {
        try {
          entries.push(await buildHookEntry(event, matcher, toHookDefinition(hook), roots, errors));
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
