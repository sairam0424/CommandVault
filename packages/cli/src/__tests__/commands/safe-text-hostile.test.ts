import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import type { ParseError, VaultEntry } from '@commandvault/core';
import { makeMockEntry } from '../fixtures/mock-vault.js';

/**
 * Every non-TUI command, fed an entry whose fields carry terminal escape sequences through a
 * mocked core, must print none of them: no ESC, no 8-bit introducer or terminator, no BEL, no
 * line separator, no bidi override. The entry must still be shown (its benign stem is present).
 */

const core = vi.hoisted(() => ({
  importFromUrl: vi.fn(),
  RegistryManager: vi.fn(),
}));

vi.mock('@commandvault/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@commandvault/core')>()),
  importFromUrl: core.importFromUrl,
  RegistryManager: core.RegistryManager,
}));

vi.mock('../../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../../helpers.js')>('../../helpers.js');
  return {
    ...actual,
    createVaultInstance: vi.fn(),
    createConfiguredVault: vi.fn(),
    withVault: vi.fn(),
  };
});

vi.mock('../../ui/spinner.js', () => {
  const spinner = {
    start: () => spinner,
    stop: () => spinner,
    succeed: () => spinner,
    fail: () => spinner,
  };
  return { createSpinner: () => spinner };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    readConfigDocument: vi.fn(async () => ({
      registries: [{ name: 'r', url: 'https://example.com/r.json', type: 'json' }],
    })),
  };
});

import {
  createConfiguredVault,
  createVaultInstance,
  printParseProblems,
  withVault,
} from '../../helpers.js';
import { createListCommand } from '../../commands/list.js';
import { createSearchCommand } from '../../commands/search.js';
import { createInfoCommand } from '../../commands/info.js';
import { createTagCommand } from '../../commands/tag.js';
import { createFavoriteCommand } from '../../commands/favorite.js';
import { createWatchCommand } from '../../commands/watch.js';
import { createSyncCommand } from '../../commands/sync.js';
import { createRegistryCommand } from '../../commands/registry.js';
import { displayEntryDetail, formatEntryChoice } from '../../commands/interactive.js';

const ESC = '\u001b';
const BEL = '\u0007';
const PAYLOAD = `${ESC}]0;PWNED${BEL}${ESC}[2J\u009d0;C1\u009c\u2028\u202e`;
const BAD_CODE_POINTS: ReadonlySet<number> = new Set([
  0x1b, 0x9b, 0x9d, 0x90, 0x9c, 0x07, 0x2028, 0x202e,
]);

const HOSTILE: VaultEntry = makeMockEntry({
  id: 'h1',
  name: `hostile-skill${PAYLOAD}`,
  description: `desc${PAYLOAD}`,
  filePath: `/tmp/esc${PAYLOAD}/SKILL.md`,
  tags: [`tag${PAYLOAD}`, 'plain'],
  metadata: { [`key${PAYLOAD}`]: `value${PAYLOAD}`, nested: { list: [`item${PAYLOAD}`] } },
});

function badCodePoints(text: string): string[] {
  return [...text]
    .filter((ch) => BAD_CODE_POINTS.has(ch.codePointAt(0) ?? 0))
    .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
}

/**
 * No control code point, and neither payload body: 'PWNED' rides the 7-bit OSC, '0;C1' the 8-bit
 * one. A body left behind means its introducer was deleted as a lone character instead of the
 * sequence being removed whole.
 */
function expectClean(text: string, stem = 'hostile-skill'): void {
  expect(badCodePoints(text)).toEqual([]);
  expect(text).not.toContain('PWNED');
  expect(text).not.toContain('0;C1');
  expect(text).toContain(stem);
}

function mockVault(entry: VaultEntry = HOSTILE) {
  const handlers = new Map<string, (value: unknown) => void>();
  return {
    handlers,
    getAllEntries: () => [entry],
    search: () => [{ entry, score: 1, matchedFields: ['name'] }],
    quickSearch: () => [{ entry, score: 1, matchedFields: ['name'] }],
    getEntry: () => entry,
    getSlashCommand: (e: VaultEntry) => `/${e.name}`,
    getTagsForEntry: () => [entry.tags[0]],
    toggleFavorite: () => true,
    recordUsage: vi.fn(),
    addEntries: vi.fn(async () => 1),
    initialize: vi.fn(async () => ({ totalEntries: 1 })),
    on: (event: string, handler: (value: unknown) => void) => {
      handlers.set(event, handler);
    },
    dispose: vi.fn(async () => undefined),
  };
}

describe('hostile entry fields never reach the terminal', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const vault = mockVault();
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);
    vi.mocked(createConfiguredVault).mockResolvedValue(vault as never);
    vi.mocked(withVault).mockImplementation(async (_opts, fn) => fn(vault as never));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const printed = (): string =>
    [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => String(call[0])).join('\n');

  async function run(command: Command, ...args: string[]): Promise<void> {
    const program = new Command();
    program.option('--json');
    program.addCommand(command);
    await program.parseAsync(['node', 'vault', ...args]);
  }

  it('list', async () => {
    await run(createListCommand(), 'list');
    expectClean(printed());
  });

  it('list --type skill (table path)', async () => {
    await run(createListCommand(), 'list', '--type', 'skill');
    expectClean(printed());
  });

  it('search', async () => {
    await run(createSearchCommand(), 'search', 'hostile');
    expectClean(printed());
  });

  it('info, including tags, file path and nested metadata', async () => {
    await run(createInfoCommand(), 'info', 'hostile');
    const text = printed();
    expectClean(text);
    expect(text).toContain('#tag');
    expect(text).toContain('#plain');
    expect(text).toContain('key');
    expect(text).toContain('item');
    expect(text).toContain('/tmp/esc');
  });

  it('info and list keep a space between the lines of a multi-line description', async () => {
    const multiLine = makeMockEntry({
      id: 'm1',
      name: 'multi-line-skill',
      description: 'First line of the description.\nSecond line, with a tab\there.\r\nThird line.',
    });
    const vault = mockVault(multiLine);
    vi.mocked(createVaultInstance).mockResolvedValue(vault as never);
    vi.mocked(withVault).mockImplementation(async (_opts, fn) => fn(vault as never));
    await run(createInfoCommand(), 'info', 'multi');
    const infoText = printed();
    logSpy.mockClear();
    errorSpy.mockClear();
    await run(createListCommand(), 'list');
    const listText = printed();
    for (const text of [infoText, listText]) {
      expectClean(text, 'multi-line-skill');
      expect(text).not.toContain('description.Second');
    }
    expect(infoText).toContain(
      'First line of the description. Second line, with a tab\there. Third line.',
    );
    // The list cell is truncated to 50 columns, so only the first join is visible there.
    expect(listText).toContain('First line of the description. Second line');
  });

  it('tag list', async () => {
    await run(createTagCommand(), 'tag', 'list', 'hostile');
    const text = printed();
    expectClean(text);
    expect(text).toContain('[user] tag');
    expect(text).toContain('[parsed] plain');
  });

  it('favorite', async () => {
    await run(createFavoriteCommand(), 'favorite', 'hostile');
    expectClean(printed());
  });

  it('watch, when the watcher reports an added and an updated entry', async () => {
    const vault = mockVault();
    vi.mocked(createConfiguredVault).mockResolvedValue(vault as never);
    void run(createWatchCommand(), 'watch');
    await vi.waitFor(() => expect(vault.handlers.has('entry:added')).toBe(true));
    vault.handlers.get('entry:added')?.(HOSTILE);
    vault.handlers.get('entry:updated')?.(HOSTILE);
    const text = printed();
    expectClean(text);
    expect(text).toContain('(added)');
    expect(text).toContain('(updated)');
  });

  it('sync --dry-run with a hostile remote entry', async () => {
    core.importFromUrl.mockResolvedValue({ entries: [HOSTILE], errors: [] });
    await run(createSyncCommand(), 'sync', 'https://example.com/r.vault.json', '--dry-run');
    expectClean(printed());
  });

  it('registry search with a hostile registry entry', async () => {
    const remote = {
      name: `hostile-skill${PAYLOAD}`,
      description: `d${PAYLOAD}`,
      type: `skill${PAYLOAD}`,
      tags: [`t${PAYLOAD}`],
      url: 'https://example.com/x',
      source: `src${PAYLOAD}`,
    };
    core.RegistryManager.mockImplementation(() => ({
      addRegistry: vi.fn(),
      search: vi.fn(async () => ({ entries: [remote], total: 1, page: 1, pageSize: 10 })),
    }));
    await createRegistryCommand()
      .exitOverride()
      .parseAsync(['search', 'hostile'], { from: 'user' });
    const text = printed();
    expectClean(text);
    expect(text).toContain('from: src');
  });

  it('interactive: the choice label and the detail block', () => {
    const label = formatEntryChoice(HOSTILE);
    expectClean(label);
    displayEntryDetail(HOSTILE, `/${HOSTILE.name}`);
    const text = printed();
    expectClean(text);
    expect(text).toContain('/hostile-skill');
  });

  it('printParseProblems with a hostile message', () => {
    const problem: ParseError = {
      filePath: `/tmp/esc${PAYLOAD}/SKILL.md`,
      message: `bad frontmatter in hostile-skill${PAYLOAD}`,
      severity: 'error',
    };
    printParseProblems([problem]);
    expectClean(printed());
  });
});
