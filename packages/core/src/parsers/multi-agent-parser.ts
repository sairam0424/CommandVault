import { readFile, readdir, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { VaultEntry, ParserResult, ParseError, EntrySource } from '../types/index.js';
import { generateId, parseFrontmatter, getLastModified, extractTags } from './utils.js';

interface AgentConfigSpec {
  readonly source: EntrySource;
  readonly label: string;
  readonly tag: string;
}

const CURSOR_SPEC: AgentConfigSpec = { source: 'cursor', label: 'Cursor Rules', tag: 'cursor' };
const COPILOT_SPEC: AgentConfigSpec = { source: 'copilot', label: 'Copilot Instructions', tag: 'copilot' };
const WINDSURF_SPEC: AgentConfigSpec = { source: 'windsurf', label: 'Windsurf Rules', tag: 'windsurf' };
const AIDER_SPEC: AgentConfigSpec = { source: 'aider', label: 'Aider Config', tag: 'aider' };
const CONTINUE_SPEC: AgentConfigSpec = { source: 'continue', label: 'Continue.dev Config', tag: 'continue' };
const CLAUDE_PROJECT_SPEC: AgentConfigSpec = { source: 'custom', label: 'Project CLAUDE.md', tag: 'claude' };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMarkdownDir(
  dirPath: string,
  spec: AgentConfigSpec,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(dirPath)).filter(
      (f) => f.endsWith('.md') || f.endsWith('.mdc')
    );
  } catch {
    return;
  }

  const parsePromises = files.map(async (file) => {
    const filePath = join(dirPath, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      const name =
        data.name ??
        `${spec.label} - ${basename(file, '.md').replace(/\.\w+$/, '').replace(/[-_]/g, ' ')}`;
      const firstLine = content.split('\n').find((l) => l.startsWith('# '));
      const description =
        typeof data.description === 'string'
          ? data.description.trim()
          : firstLine?.replace(/^#\s+/, '') ?? `${spec.label} from ${file}`;
      const tags = extractTags(name, description, data);
      tags.push(spec.tag, 'ai-agent-config');
      const lastModified = await getLastModified(filePath);

      const entry: VaultEntry = {
        id: generateId(filePath),
        name,
        type: 'rule',
        source: spec.source,
        description,
        filePath,
        tags,
        metadata: { fileName: file, agentTool: spec.tag },
        content,
        lastModified,
        favorite: false,
        usageCount: 0,
      };
      entries.push(entry);
    } catch (err) {
      errors.push({
        filePath,
        message: `Failed to parse ${spec.label} file: ${(err as Error).message}`,
        cause: err,
      });
    }
  });

  await Promise.all(parsePromises);
}

async function readSingleFile(
  filePath: string,
  name: string,
  spec: AgentConfigSpec,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }

  try {
    const raw = await readFile(filePath, 'utf-8');
    const isJson = filePath.endsWith('.json');
    const isYaml = filePath.endsWith('.yml') || filePath.endsWith('.yaml');

    let content: string;
    let description: string;
    let metadata: Record<string, unknown> = { fileName: basename(filePath), agentTool: spec.tag };

    if (isJson) {
      content = raw;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        description = typeof parsed.description === 'string'
          ? parsed.description
          : `${name} configuration`;
        metadata = { ...metadata, parsedKeys: Object.keys(parsed) };
      } catch {
        description = `${name} configuration`;
      }
    } else if (isYaml) {
      content = raw;
      const firstComment = raw
        .split('\n')
        .find((l) => l.startsWith('#'));
      description = firstComment
        ? firstComment.replace(/^#\s*/, '')
        : `${name} configuration`;
    } else {
      const { data, content: mdContent } = parseFrontmatter(raw);
      content = mdContent;
      const firstLine = mdContent.split('\n').find((l) => l.startsWith('# '));
      description =
        typeof data.description === 'string'
          ? data.description.trim()
          : firstLine?.replace(/^#\s+/, '') ?? `${name}`;
      const fmTags = extractTags(name, description, data);
      metadata = { ...metadata, frontmatter: data, extractedTags: fmTags };
    }

    const tags = [spec.tag, 'ai-agent-config'];
    const lastModified = await getLastModified(filePath);

    const entry: VaultEntry = {
      id: generateId(filePath),
      name,
      type: 'rule',
      source: spec.source,
      description,
      filePath,
      tags,
      metadata,
      content,
      lastModified,
      favorite: false,
      usageCount: 0,
    };
    entries.push(entry);
  } catch (err) {
    errors.push({
      filePath,
      message: `Failed to parse ${name}: ${(err as Error).message}`,
      cause: err,
    });
  }
}

async function detectCursorConfigs(
  projectRoot: string,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  const cursorRulesDir = join(projectRoot, '.cursor', 'rules');
  const cursorRulesFile = join(projectRoot, '.cursorrules');

  await Promise.all([
    readMarkdownDir(cursorRulesDir, CURSOR_SPEC, entries, errors),
    readSingleFile(cursorRulesFile, 'Cursor Rules (project root)', CURSOR_SPEC, entries, errors),
  ]);
}

async function detectCopilotConfigs(
  projectRoot: string,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  const copilotInstructions = join(projectRoot, '.github', 'copilot-instructions.md');
  await readSingleFile(copilotInstructions, 'Copilot Instructions', COPILOT_SPEC, entries, errors);
}

async function detectWindsurfConfigs(
  projectRoot: string,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  const windsurfRulesFile = join(projectRoot, '.windsurfrules');
  const windsurfRulesDir = join(projectRoot, '.windsurf', 'rules');

  await Promise.all([
    readSingleFile(windsurfRulesFile, 'Windsurf Rules (project root)', WINDSURF_SPEC, entries, errors),
    readMarkdownDir(windsurfRulesDir, WINDSURF_SPEC, entries, errors),
  ]);
}

async function detectAiderConfigs(
  projectRoot: string,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  const home = homedir();
  const projectConfig = join(projectRoot, '.aider.conf.yml');
  const homeConfig = join(home, '.aider.conf.yml');

  await Promise.all([
    readSingleFile(projectConfig, 'Aider Config (project)', AIDER_SPEC, entries, errors),
    readSingleFile(homeConfig, 'Aider Config (global)', AIDER_SPEC, entries, errors),
  ]);
}

async function detectContinueConfigs(
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  const home = homedir();
  const continueConfig = join(home, '.continue', 'config.json');
  await readSingleFile(continueConfig, 'Continue.dev Config', CONTINUE_SPEC, entries, errors);
}

async function detectProjectClaudeConfigs(
  projectRoot: string,
  entries: VaultEntry[],
  errors: ParseError[]
): Promise<void> {
  const rootClaudeMd = join(projectRoot, 'CLAUDE.md');
  const claudeDir = join(projectRoot, '.claude');

  await Promise.all([
    readSingleFile(rootClaudeMd, 'Project CLAUDE.md', CLAUDE_PROJECT_SPEC, entries, errors),
    readMarkdownDir(claudeDir, CLAUDE_PROJECT_SPEC, entries, errors),
  ]);
}

export async function detectAgentConfigs(projectRoot: string): Promise<ParserResult> {
  const entries: VaultEntry[] = [];
  const errors: ParseError[] = [];

  await Promise.all([
    detectCursorConfigs(projectRoot, entries, errors),
    detectCopilotConfigs(projectRoot, entries, errors),
    detectWindsurfConfigs(projectRoot, entries, errors),
    detectAiderConfigs(projectRoot, entries, errors),
    detectContinueConfigs(entries, errors),
    detectProjectClaudeConfigs(projectRoot, entries, errors),
  ]);

  return { entries, errors };
}
