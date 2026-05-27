import type { ParserResult, ParsedFrontmatter } from '../types/index.js';
import { parseMarkdownDir, type ParseConfig, type ParseContext } from './base-parser.js';
import { inferSource } from './utils.js';
import { basename } from 'node:path';

const agentConfig: ParseConfig = {
  type: 'agent',
  filePattern: /\.md$/,
  scanMode: 'files',
  dirNotFoundMessage: 'Agents directory not found',
  useRetry: true,
  nameFromPath: (_folderName: string, data: ParsedFrontmatter, context: ParseContext) =>
    data.name ?? basename(context.fileName, '.md'),
  idDisambiguator: (name: string, filePath: string) => inferSource(name, filePath),
  extractMetadata: (data: ParsedFrontmatter, _content: string, context: ParseContext) => ({
    color: data.color,
    emoji: data.emoji,
    vibe: data.vibe,
    fileName: context.fileName,
  }),
};

export async function parseAgents(agentsDir: string): Promise<ParserResult> {
  return parseMarkdownDir(agentsDir, agentConfig);
}
