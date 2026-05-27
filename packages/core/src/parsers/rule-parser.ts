import { basename } from 'node:path';
import type { ParserResult, ParsedFrontmatter } from '../types/index.js';
import { parseMarkdownDir, type ParseConfig, type ParseContext } from './base-parser.js';

const ruleConfig: ParseConfig = {
  type: 'rule',
  filePattern: /\.md$/,
  scanMode: 'files',
  dirNotFoundMessage: 'Rules directory not found',
  nameFromPath: (_folderName: string, data: ParsedFrontmatter, context: ParseContext) =>
    data.name ?? basename(context.fileName, '.md').replace(/-/g, ' '),
  descriptionFromContent: (data: ParsedFrontmatter, content: string, context: ParseContext) => {
    if (typeof data.description === 'string') return data.description.trim();
    const firstLine = content.split('\n').find((l) => l.startsWith('# '));
    const name = data.name ?? basename(context.fileName, '.md').replace(/-/g, ' ');
    return firstLine?.replace(/^#\s+/, '') ?? `Rule: ${name}`;
  },
  postProcessTags: (tags: string[]) => [...tags, 'rule'],
  idDisambiguator: () => '',
  extractMetadata: (_data: ParsedFrontmatter, _content: string, context: ParseContext) => ({
    fileName: context.fileName,
  }),
};

export async function parseRules(rulesDir: string): Promise<ParserResult> {
  return parseMarkdownDir(rulesDir, ruleConfig);
}
