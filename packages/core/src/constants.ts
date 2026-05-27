export const TYPE_EMOJIS: Readonly<Record<string, string>> = {
  skill: '\u{1F9E0}',
  agent: '\u{1F916}',
  command: '\u{26A1}',
  plugin: '\u{1F50C}',
  rule: '\u{1F4CF}',
  hook: '\u{1FA9D}',
};

export const TYPE_COLORS: Readonly<Record<string, string>> = {
  skill: 'cyan',
  agent: 'blue',
  command: 'yellow',
  plugin: 'green',
  rule: 'magenta',
  hook: 'red',
};

export const TYPE_LABELS: Readonly<Record<string, string>> = {
  skill: 'Skill',
  agent: 'Agent',
  command: 'Command',
  plugin: 'Plugin',
  rule: 'Rule',
  hook: 'Hook',
};

export const KNOWN_ENTRY_TYPES: readonly string[] = [
  'skill',
  'agent',
  'command',
  'plugin',
  'rule',
  'hook',
];
