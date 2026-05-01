import { relative, sep } from 'node:path';

export type ParserType =
  | 'skill'
  | 'agent'
  | 'command'
  | 'plugin'
  | 'rule'
  | 'hook';

export function routePathToParser(
  changedPath: string,
  claudePath: string,
): ParserType | null {
  const rel = relative(claudePath, changedPath).split(sep).join('/');

  if (rel.startsWith('skills/')) return 'skill';
  if (rel.startsWith('agents/')) return 'agent';
  if (rel.startsWith('commands/')) return 'command';
  if (rel.startsWith('plugins/')) return 'plugin';
  if (rel.startsWith('rules/')) return 'rule';
  if (rel === 'settings.json') return 'hook';

  return null;
}
