import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Builds a Claude configuration directory of a realistic size out of nothing, so tests that need a
 * large corpus never depend on the developer's own ~/.claude (which has a different size, different
 * names and, in a sandbox or on CI, does not exist at all).
 */

export const SYNTHETIC_SKILL_COUNT = 150;
export const SYNTHETIC_COMMAND_COUNT = 40;
export const SYNTHETIC_RULE_COUNT = 30;
export const SYNTHETIC_AGENT_COUNT = 15;
export const SYNTHETIC_HOOK_COUNT = 1;

export const SYNTHETIC_ENTRY_COUNT =
  SYNTHETIC_SKILL_COUNT +
  SYNTHETIC_COMMAND_COUNT +
  SYNTHETIC_RULE_COUNT +
  SYNTHETIC_AGENT_COUNT +
  SYNTHETIC_HOOK_COUNT;

/** Skills whose names the search assertions look for. */
const REVIEW_SKILL_COUNT = 5;
const TEST_SKILL_COUNT = 5;

async function writeFileIn(root: string, relative: string, text: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function markdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;
}

/** The last skill is `browse`: a folder of that name is what the source detector attributes to gstack. */
function skillName(index: number): string {
  if (index === SYNTHETIC_SKILL_COUNT - 1) return 'browse';
  if (index < REVIEW_SKILL_COUNT) return `code-review-${index}`;
  if (index < REVIEW_SKILL_COUNT + TEST_SKILL_COUNT) return `test-helper-${index}`;
  return `skill-${index}`;
}

function numbered(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

export async function buildSyntheticClaudeDir(root: string): Promise<void> {
  const skills = Array.from({ length: SYNTHETIC_SKILL_COUNT }, (_, index) => skillName(index)).map(
    (name) => writeFileIn(root, `skills/${name}/SKILL.md`, markdown(name, `Skill ${name}`)),
  );
  const commands = numbered(SYNTHETIC_COMMAND_COUNT, 'command').map((name) =>
    writeFileIn(root, `commands/${name}.md`, markdown(name, `Command ${name}`)),
  );
  const rules = numbered(SYNTHETIC_RULE_COUNT, 'rule').map((name) =>
    writeFileIn(root, `rules/${name}.md`, `# ${name}\nAlways follow ${name}.\n`),
  );
  const agents = numbered(SYNTHETIC_AGENT_COUNT, 'agent').map((name) =>
    writeFileIn(root, `agents/${name}.md`, markdown(name, `Agent ${name}`)),
  );
  const settings = writeFileIn(
    root,
    'settings.json',
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo synthetic' }] }],
      },
    }),
  );

  await Promise.all([...skills, ...commands, ...rules, ...agents, settings]);
}
