import type { ParserResult, ParsedFrontmatter } from '../types/index.js';
import { parseMarkdownDir, type ParseConfig, type ParseContext } from './base-parser.js';

const skillConfig: ParseConfig = {
  type: 'skill',
  filePattern: /^SKILL\.md$/,
  scanMode: 'subdirs',
  dirNotFoundMessage: 'Skills directory not found',
  useRetry: true,
  skipEnoent: true,
  nameFromPath: (folderName: string, data: ParsedFrontmatter, _context: ParseContext) =>
    data.name ?? folderName,
  extractMetadata: (data: ParsedFrontmatter, _content: string, context: ParseContext) => ({
    version: data.version,
    preambleTier: data.preambleTier ?? data['preamble-tier'],
    triggers: data.triggers,
    allowedTools: data.allowedTools ?? data['allowed-tools'],
    folderName: context.folderName,
  }),
};

export async function parseSkills(skillsDir: string): Promise<ParserResult> {
  return parseMarkdownDir(skillsDir, skillConfig);
}
