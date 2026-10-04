import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHooks } from '../parsers/hook-parser.js';

let tempDir: string;
let settingsPath: string;

async function writeSettings(settings: unknown): Promise<void> {
  await writeFile(settingsPath, JSON.stringify(settings), 'utf-8');
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cv-hook-robustness-'));
  settingsPath = join(tempDir, 'settings.json');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('parseHooks: hooks without a matcher (optional in Claude Code)', () => {
  it('parses a Stop hook that has no matcher key', async () => {
    await writeSettings({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/notify.js' }] }] },
    });

    const result = await parseHooks(settingsPath);

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('Stop:*:notify');
    expect(result.entries[0].metadata.matcher).toBe('*');
    expect(result.entries[0].tags).toContain('stop');
  });

  it('parses a UserPromptSubmit hook that has no matcher key', async () => {
    await writeSettings({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/prompt-log.js' }] }],
      },
    });

    const result = await parseHooks(settingsPath);

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].metadata.event).toBe('UserPromptSubmit');
    expect(result.entries[0].metadata.matcher).toBe('*');
  });

  it('treats a non-string matcher as match-all instead of throwing', async () => {
    await writeSettings({
      hooks: { PreToolUse: [{ matcher: null, hooks: [{ type: 'command', command: 'run.js' }] }] },
    });

    const result = await parseHooks(settingsPath);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].metadata.matcher).toBe('*');
  });

  it.each([
    ['an empty string', '', '*'],
    ['whitespace only', '  ', '*'],
    ['a tab and newline', '\t\n', '*'],
    ['an explicit wildcard', '*', '*'],
    ['a tool name', 'Bash', 'Bash'],
    ['a tool alternation', 'Write|Edit', 'Write|Edit'],
  ])('resolves %s matcher to the effective matcher', async (_label, matcher, expected) => {
    await writeSettings({
      hooks: {
        PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'node /x/script.js' }] }],
      },
    });

    const result = await parseHooks(settingsPath);

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe(`PreToolUse:${expected}:script`);
    expect(result.entries[0].metadata.matcher).toBe(expected);
    expect(result.entries[0].tags).toContain(expected.toLowerCase());
  });
});

describe('parseHooks: malformed hook definitions are isolated', () => {
  it('reports a non-string command as a ParseError and still parses the sibling hooks', async () => {
    await writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 5 },
              { type: 'command', command: 'node /x/good.js' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'node /x/also-good.js' }] }],
      },
    });

    const result = await parseHooks(settingsPath);

    expect(result.entries.map((e) => e.name).sort()).toEqual([
      'PreToolUse:Bash:good',
      'Stop:*:also-good',
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(settingsPath);
    expect(result.errors[0].message).toContain('command');
  });

  it('reports null and command-less hook objects without rejecting', async () => {
    await writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [null, { type: 'command' }, 'garbage'] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node /x/fmt.js' }] },
        ],
      },
    });

    const result = await parseHooks(settingsPath);

    expect(result.entries.map((e) => e.name)).toEqual(['PostToolUse:Write:fmt']);
    expect(result.errors).toHaveLength(3);
  });

  it('returns a ParseError for a settings file whose JSON root is not an object', async () => {
    await writeFile(settingsPath, 'null', 'utf-8');

    const result = await parseHooks(settingsPath);

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(settingsPath);
  });
});
