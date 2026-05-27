import { parseSkills } from './skill-parser.js';
import { parseAgents } from './agent-parser.js';
import { parseCommands } from './command-parser.js';
import { parsePlugins } from './plugin-parser.js';
import { parseRules } from './rule-parser.js';
import { parseHooks } from './hook-parser.js';
import { TYPE_EMOJIS, TYPE_COLORS, TYPE_LABELS } from '../constants.js';
import type { ParserRegistry } from './parser-registry.js';

export function registerBuiltinParsers(registry: ParserRegistry): void {
  registry.register({
    type: 'skill',
    displayName: TYPE_LABELS['skill'],
    emoji: TYPE_EMOJIS['skill'],
    color: TYPE_COLORS['skill'],
    globPatterns: ['skills/*/SKILL.md'],
    parse: parseSkills,
  });

  registry.register({
    type: 'agent',
    displayName: TYPE_LABELS['agent'],
    emoji: TYPE_EMOJIS['agent'],
    color: TYPE_COLORS['agent'],
    globPatterns: ['agents/*.md'],
    parse: parseAgents,
  });

  registry.register({
    type: 'command',
    displayName: TYPE_LABELS['command'],
    emoji: TYPE_EMOJIS['command'],
    color: TYPE_COLORS['command'],
    globPatterns: ['commands/**/*.md'],
    parse: parseCommands,
  });

  registry.register({
    type: 'plugin',
    displayName: TYPE_LABELS['plugin'],
    emoji: TYPE_EMOJIS['plugin'],
    color: TYPE_COLORS['plugin'],
    globPatterns: ['plugins/installed_plugins.json'],
    parse: parsePlugins,
  });

  registry.register({
    type: 'rule',
    displayName: TYPE_LABELS['rule'],
    emoji: TYPE_EMOJIS['rule'],
    color: TYPE_COLORS['rule'],
    globPatterns: ['rules/*.md'],
    parse: parseRules,
  });

  registry.register({
    type: 'hook',
    displayName: TYPE_LABELS['hook'],
    emoji: TYPE_EMOJIS['hook'],
    color: TYPE_COLORS['hook'],
    globPatterns: ['settings.json'],
    parse: parseHooks,
  });
}
