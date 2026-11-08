import { constants } from 'node:fs';
import { readdir, access, lstat, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import type { VaultEntry, ParserResult, ParseError, EntrySource } from '../types/index.js';
import { generateStableId, parseFrontmatter, getLastModified, extractTags } from './utils.js';
import { skippedFrontmatterWarnings } from './base-parser.js';
import { describeFileFailure } from './bounded-read.js';
import {
  containedIn,
  followFileLinks,
  linkMetadata,
  linkTags,
  readLinkedText,
  type LinkPolicy,
} from './link-policy.js';
import { truncatedFrontmatterWarning } from './sanitize-frontmatter.js';
import { deriveRuleDescription } from './rule-parser.js';
import { runParserSafely } from '../scan-pipeline.js';

interface AgentConfigSpec {
  readonly source: EntrySource;
  readonly label: string;
  readonly tag: string;
}

const CURSOR_SPEC: AgentConfigSpec = { source: 'cursor', label: 'Cursor Rules', tag: 'cursor' };
const COPILOT_SPEC: AgentConfigSpec = {
  source: 'copilot',
  label: 'Copilot Instructions',
  tag: 'copilot',
};
const WINDSURF_SPEC: AgentConfigSpec = {
  source: 'windsurf',
  label: 'Windsurf Rules',
  tag: 'windsurf',
};
const AIDER_SPEC: AgentConfigSpec = { source: 'aider', label: 'Aider Config', tag: 'aider' };
const CONTINUE_SPEC: AgentConfigSpec = {
  source: 'continue',
  label: 'Continue.dev Config',
  tag: 'continue',
};
const CLAUDE_PROJECT_SPEC: AgentConfigSpec = {
  source: 'custom',
  label: 'Project CLAUDE.md',
  tag: 'claude',
};

/** True when something is at the path, a dangling link included: what it points at is the policy's call. */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMarkdownDir(
  dirPath: string,
  spec: AgentConfigSpec,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(dirPath)).filter((f) => f.endsWith('.md') || f.endsWith('.mdc'));
  } catch {
    return;
  }

  const parsePromises = files.map(async (file) => {
    const filePath = join(dirPath, file);
    try {
      const link = await policy(filePath);
      const raw = await readLinkedText(link);
      const { data, content, dropped, recoveryCause } = parseFrontmatter(raw);
      const name =
        data.name ??
        `${spec.label} - ${basename(file, '.md')
          .replace(/\.\w+$/, '')
          .replace(/[-_]/g, ' ')}`;
      const description = deriveRuleDescription(data, content, file, `${spec.label} from ${file}`);
      const tags = extractTags(name, description, data);
      tags.push(spec.tag, 'ai-agent-config', ...linkTags(link));
      const lastModified = await getLastModified(link.readPath);

      const entry: VaultEntry = {
        id: generateStableId('rule', name, spec.source),
        name,
        type: 'rule',
        source: spec.source,
        description,
        filePath,
        tags,
        metadata: { fileName: file, agentTool: spec.tag, ...linkMetadata(link) },
        content,
        lastModified,
        favorite: false,
        usageCount: 0,
      };
      entries.push(entry);
      errors.push(...skippedFrontmatterWarnings(spec.label, filePath, recoveryCause));
      if (dropped) errors.push(truncatedFrontmatterWarning(spec.label, filePath, dropped));
    } catch (err) {
      errors.push(
        describeFileFailure(err, filePath, `Failed to parse ${spec.label} file`, spec.label),
      );
    }
  });

  await Promise.all(parsePromises);
}

interface FileDigest {
  readonly content: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly dropped: number;
  /** Why the guard skipped the frontmatter, when it did. */
  readonly skipCause?: unknown;
}

function digestJson(raw: string, name: string): FileDigest {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const description =
      typeof parsed.description === 'string' ? parsed.description : `${name} configuration`;
    return { content: raw, description, metadata: { parsedKeys: Object.keys(parsed) }, dropped: 0 };
  } catch {
    return { content: raw, description: `${name} configuration`, metadata: {}, dropped: 0 };
  }
}

function digestYaml(raw: string, name: string): FileDigest {
  const firstComment = raw.split('\n').find((l) => l.startsWith('#'));
  const description = firstComment ? firstComment.replace(/^#\s*/, '') : `${name} configuration`;
  return { content: raw, description, metadata: {}, dropped: 0 };
}

function digestMarkdown(raw: string, filePath: string, name: string): FileDigest {
  const { data, content, dropped, recoveryCause } = parseFrontmatter(raw);
  const description = deriveRuleDescription(data, content, basename(filePath), name);
  const extractedTags = extractTags(name, description, data);
  return {
    content,
    description,
    metadata: { frontmatter: data, extractedTags },
    dropped: dropped ?? 0,
    skipCause: recoveryCause,
  };
}

function digestSingleFile(raw: string, filePath: string, name: string): FileDigest {
  if (filePath.endsWith('.json')) return digestJson(raw, name);
  if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) return digestYaml(raw, name);
  return digestMarkdown(raw, filePath, name);
}

async function readSingleFile(
  filePath: string,
  name: string,
  spec: AgentConfigSpec,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }

  try {
    const link = await policy(filePath);
    const raw = await readLinkedText(link);
    const digest = digestSingleFile(raw, filePath, name);
    const lastModified = await getLastModified(link.readPath);

    const entry: VaultEntry = {
      id: generateStableId('rule', name),
      name,
      type: 'rule',
      source: spec.source,
      description: digest.description,
      filePath,
      tags: [spec.tag, 'ai-agent-config', ...linkTags(link)],
      metadata: {
        fileName: basename(filePath),
        agentTool: spec.tag,
        ...digest.metadata,
        ...linkMetadata(link),
      },
      content: digest.content,
      lastModified,
      favorite: false,
      usageCount: 0,
    };
    entries.push(entry);
    errors.push(...skippedFrontmatterWarnings(name, filePath, digest.skipCause));
    if (digest.dropped > 0)
      errors.push(truncatedFrontmatterWarning(name, filePath, digest.dropped));
  } catch (err) {
    errors.push(describeFileFailure(err, filePath, `Failed to parse ${name}`, name));
  }
}

async function detectCursorConfigs(
  projectRoot: string,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const cursorRulesDir = join(projectRoot, '.cursor', 'rules');
  const cursorRulesFile = join(projectRoot, '.cursorrules');
  const name = 'Cursor Rules (project root)';

  await Promise.all([
    readMarkdownDir(cursorRulesDir, CURSOR_SPEC, policy, entries, errors),
    readSingleFile(cursorRulesFile, name, CURSOR_SPEC, policy, entries, errors),
  ]);
}

async function detectCopilotConfigs(
  projectRoot: string,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const copilotInstructions = join(projectRoot, '.github', 'copilot-instructions.md');
  const name = 'Copilot Instructions';
  await readSingleFile(copilotInstructions, name, COPILOT_SPEC, policy, entries, errors);
}

async function detectWindsurfConfigs(
  projectRoot: string,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const windsurfRulesFile = join(projectRoot, '.windsurfrules');
  const windsurfRulesDir = join(projectRoot, '.windsurf', 'rules');
  const name = 'Windsurf Rules (project root)';

  await Promise.all([
    readSingleFile(windsurfRulesFile, name, WINDSURF_SPEC, policy, entries, errors),
    readMarkdownDir(windsurfRulesDir, WINDSURF_SPEC, policy, entries, errors),
  ]);
}

async function detectProjectAiderConfig(
  projectRoot: string,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const projectConfig = join(projectRoot, '.aider.conf.yml');
  const name = 'Aider Config (project)';
  await readSingleFile(projectConfig, name, AIDER_SPEC, policy, entries, errors);
}

async function detectHomeAiderConfig(
  home: string,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const homeConfig = join(home, '.aider.conf.yml');
  const name = 'Aider Config (global)';
  await readSingleFile(homeConfig, name, AIDER_SPEC, followFileLinks, entries, errors);
}

async function detectContinueConfigs(
  home: string,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const continueConfig = join(home, '.continue', 'config.json');
  const name = 'Continue.dev Config';
  await readSingleFile(continueConfig, name, CONTINUE_SPEC, followFileLinks, entries, errors);
}

async function detectProjectClaudeConfigs(
  projectRoot: string,
  policy: LinkPolicy,
  entries: VaultEntry[],
  errors: ParseError[],
): Promise<void> {
  const rootClaudeMd = join(projectRoot, 'CLAUDE.md');
  const claudeDir = join(projectRoot, '.claude');
  const name = 'Project CLAUDE.md';

  await Promise.all([
    readSingleFile(rootClaudeMd, name, CLAUDE_PROJECT_SPEC, policy, entries, errors),
    readMarkdownDir(claudeDir, CLAUDE_PROJECT_SPEC, policy, entries, errors),
  ]);
}

/** The project directory is untrusted: every file read must resolve inside it. */
async function detectProjectConfigs(projectRoot: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];
  const policy = containedIn(projectRoot);

  await Promise.all([
    detectCursorConfigs(projectRoot, policy, entries, errors),
    detectCopilotConfigs(projectRoot, policy, entries, errors),
    detectWindsurfConfigs(projectRoot, policy, entries, errors),
    detectProjectAiderConfig(projectRoot, policy, entries, errors),
    detectProjectClaudeConfigs(projectRoot, policy, entries, errors),
  ]);

  return { entries, errors };
}

/**
 * The account's home directory, resolved the way `paths.ts` resolves it for the Claude directory:
 * `os.homedir()`, with the passwd entry standing in when that is empty (HOME set and empty, which
 * would make every path below relative to the current directory) or throws (Windows without
 * USERPROFILE). Throws when neither knows the home.
 */
function accountHome(): string {
  try {
    const home = homedir();
    if (home) return home;
  } catch {
    // Fall through to the passwd entry.
  }
  const home = userInfo().homedir;
  if (!home) throw new Error('the account has an empty home directory');
  return home;
}

function homeUnavailable(cause: unknown): ParseError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return {
    filePath: '',
    message: `Cannot determine the home directory, so ~/.aider.conf.yml and ~/.continue/config.json were not read: ${reason}`,
    severity: 'error',
    cause,
  };
}

/** Never rejects: not knowing the home costs this part only, never the project part beside it. */
async function detectHomeConfigs(): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  let home: string;
  try {
    home = accountHome();
  } catch (err) {
    return { entries, errors: [homeUnavailable(err)] };
  }

  await Promise.all([
    detectHomeAiderConfig(home, entries, errors),
    detectContinueConfigs(home, entries, errors),
  ]);

  return { entries, errors };
}

/**
 * The absolute form of an explicit project directory. A blank value stays blank, because
 * `resolve('')` is the current directory and a scan must never land there by accident.
 */
export function resolveProjectRoot(projectRoot: string): string {
  return projectRoot.trim() === '' ? '' : resolve(projectRoot);
}

/** Why `projectRoot` cannot be scanned, or null when it is an existing directory. */
async function describeProjectRootProblem(projectRoot: string): Promise<ParseError | null> {
  if (projectRoot === '') {
    return {
      filePath: '',
      message:
        'Cannot scan a project directory: the path is empty. Pass the directory to scan, or omit it to skip the project scan',
      severity: 'error',
    };
  }

  try {
    if (!(await stat(projectRoot)).isDirectory()) {
      return {
        filePath: projectRoot,
        message: `Project path is not a directory: ${projectRoot}`,
        severity: 'error',
      };
    }
    // A directory can stat fine and still be closed to this account (mode bits, macOS privacy
    // protection). The readers below treat any failure to reach a file as "not there", so without
    // this probe the scan would come back empty, with no error.
    await access(projectRoot, constants.R_OK | constants.X_OK);
    return null;
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    const reason = err instanceof Error ? err.message : String(err);
    return {
      filePath: projectRoot,
      message: isMissing
        ? `Project directory does not exist: ${projectRoot}`
        : `Cannot read project directory ${projectRoot}: ${reason}`,
      severity: 'error',
      cause: err,
    };
  }
}

async function scanProjectRoot(projectRoot: string): Promise<ParserResult> {
  const root = resolveProjectRoot(projectRoot);
  const problem = await describeProjectRootProblem(root);
  if (problem) return { entries: [], errors: [problem] };
  return detectProjectConfigs(root);
}

function mergeResults(results: readonly ParserResult[]): ParserResult {
  return {
    entries: results.flatMap((result) => result.entries),
    errors: results.flatMap((result) => result.errors),
  };
}

/**
 * Agent configs that live outside the Claude config directory. The account-level ones under the
 * home directory (`~/.aider.conf.yml`, `~/.continue/config.json`) are always read, from the home
 * directory as it is when this runs. A project directory is read only when one is given, and
 * never implied from the current directory: the result must not depend on where the caller runs.
 * A given directory that is empty, missing or not a directory is an error in the result, and so
 * is a home directory that cannot be determined. The two parts are independent: either failing
 * leaves the other's entries in the result.
 */
export async function detectAgentConfigs(projectRoot?: string): Promise<ParserResult> {
  return mergeResults(
    await Promise.all([
      detectHomeConfigs(),
      projectRoot === undefined ? { entries: [], errors: [] } : scanProjectRoot(projectRoot),
    ]),
  );
}

/** The parser name a problem found while reading agent configs is attributed to. */
export const AGENT_CONFIG_PARSER = 'agent-configs';

/**
 * A rules run plus the agent configs, which are indexed as rules too. The detection cannot
 * reject: its failure becomes an "agent-configs" problem and the rules result is kept.
 */
export async function withAgentConfigs(
  parseRules: () => Promise<ParserResult>,
  projectRoot?: string,
): Promise<ParserResult> {
  const detect = () =>
    runParserSafely(AGENT_CONFIG_PARSER, projectRoot ?? '', () => detectAgentConfigs(projectRoot));
  return mergeResults(await Promise.all([parseRules(), detect()]));
}
