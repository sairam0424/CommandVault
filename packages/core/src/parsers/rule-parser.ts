import { basename } from 'node:path';
import type { ParserResult, ParsedFrontmatter } from '../types/index.js';
import { parseMarkdownDir, type ParseConfig, type ParseContext } from './base-parser.js';

/**
 * Rule description: the declared one when it has text, else the first `# ` heading, else
 * `lastResort` (default `Rule: <name>`). Shared by the directory scan, the single-file re-parse
 * and the project agent-config scan so a blank `description: ""` reads the same everywhere.
 */
export function deriveRuleDescription(
  data: ParsedFrontmatter,
  content: string,
  fileName: string,
  lastResort?: string,
): string {
  if (typeof data.description === 'string' && data.description.trim() !== '') {
    return data.description.trim();
  }
  const heading = content.split('\n').find((l) => l.startsWith('# '));
  const name = data.name ?? basename(fileName, '.md').replace(/-/g, ' ');
  return heading?.replace(/^#\s+/, '') ?? lastResort ?? `Rule: ${name}`;
}

const ruleConfig: ParseConfig = {
  type: 'rule',
  filePattern: /\.md$/,
  scanMode: 'files',
  dirNotFoundMessage: 'Rules directory not found',
  nameFromPath: (_folderName: string, data: ParsedFrontmatter, context: ParseContext) =>
    data.name ?? basename(context.fileName, '.md').replace(/-/g, ' '),
  descriptionFromContent: (data: ParsedFrontmatter, content: string, context: ParseContext) =>
    deriveRuleDescription(data, content, context.fileName),
  postProcessTags: (tags: string[]) => [...tags, 'rule'],
  idDisambiguator: () => '',
  extractMetadata: (_data: ParsedFrontmatter, _content: string, context: ParseContext) => ({
    fileName: context.fileName,
  }),
};

export async function parseRules(rulesDir: string): Promise<ParserResult> {
  return parseMarkdownDir(rulesDir, ruleConfig);
}
