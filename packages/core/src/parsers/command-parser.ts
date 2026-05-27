import { basename } from 'node:path';
import type { ParserResult, ParsedFrontmatter } from '../types/index.js';
import { parseMarkdownDir, type ParseConfig, type ParseContext } from './base-parser.js';
import { inferSource } from './utils.js';

const commandConfig: ParseConfig = {
  type: 'command',
  filePattern: /\.md$/,
  scanMode: 'walk',
  dirNotFoundMessage: 'Commands directory not found',
  nameFromPath: (folderName: string, data: ParsedFrontmatter, context: ParseContext) => {
    if (data.name) return data.name as string;
    const parentDir = folderName;
    const fileName = basename(context.fileName, '.md');
    return parentDir !== 'commands' ? `${parentDir}:${fileName}` : fileName;
  },
  idDisambiguator: (name: string, filePath: string) => inferSource(name, filePath),
  extractMetadata: (_data: ParsedFrontmatter, _content: string, context: ParseContext) => ({
    namespace: context.folderName !== 'commands' ? context.folderName : undefined,
    fileName: context.fileName,
  }),
};

export async function parseCommands(commandsDir: string): Promise<ParserResult> {
  return parseMarkdownDir(commandsDir, commandConfig);
}
