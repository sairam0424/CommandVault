import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { window, workspace } from 'vscode';
import { configurationWith } from './helpers/vscode-extras';
import {
  linksIn,
  linksInShownNotifications,
  shownNotifications,
} from './helpers/notification-links';
import { openPanelHandler } from './helpers/panel-handler';

/**
 * VS Code draws `[label](command:...)` in any notification as a button that runs the command, and a
 * file name is attacker-chosen text: a plugin can ship a command file whose NAME is this. Whatever
 * the panel shows about a failure must therefore not repeat the path or the error message, which
 * holds the path.
 */
const PAYLOAD =
  '[open](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22touch%20pwned%22%7D)';
const FAILURE_PREFIX = 'CommandVault: Could not open file';

const CLAUDE_DIR = join(homedir(), '.claude');
const OUTSIDE_DIR = join(homedir(), 'outside-notifications');

function writeFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# entry\n');
  return path;
}

describe('Detail panel: notifications never carry entry-derived link syntax', () => {
  let savedClaudeDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(configurationWith({}));
  });

  afterEach(() => {
    if (savedClaudeDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
    }
    for (const dir of [CLAUDE_DIR, OUTSIDE_DIR]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function send(message: Record<string, unknown>): Promise<void> {
    await openPanelHandler()(message);
  }

  function expectNoLinks(): void {
    expect(linksInShownNotifications()).toEqual([]);
    for (const shown of shownNotifications()) {
      expect(shown).not.toContain('command:');
    }
  }

  it('finds the link in the message the panel used to show, so the scan below can fail', () => {
    const old = `CommandVault: Could not open file - ENOENT: no such file or directory, realpath '${PAYLOAD}/plugin.json'`;

    expect(linksIn(old)).toEqual([
      { label: 'open', href: expect.stringMatching(/^command:workbench\.action\.terminal/) },
    ]);
  });

  it('shows only the error code when a file with a hostile name has gone (ENOENT)', async () => {
    mkdirSync(CLAUDE_DIR, { recursive: true });

    await send({ type: 'openFile', path: join(CLAUDE_DIR, 'plugins', PAYLOAD, 'plugin.json') });

    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(shownNotifications()[0]).toMatch(/^CommandVault: Could not open file \([A-Z]+\)$/);
    expectNoLinks();
  });

  it('does not repeat the message of an error thrown while opening', async () => {
    const file = writeFile(join(CLAUDE_DIR, 'commands', 'review.md'));
    (workspace.openTextDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`Unable to open '${file}' ${PAYLOAD}`),
    );

    await send({ type: 'openFile', path: file });

    expect(shownNotifications()).toEqual([FAILURE_PREFIX]);
    expectNoLinks();
  });

  it('ignores an error code that is not an identifier', async () => {
    const file = writeFile(join(CLAUDE_DIR, 'commands', 'review.md'));
    (workspace.openTextDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('failed'), { code: PAYLOAD }),
    );

    await send({ type: 'openFile', path: file });

    expect(shownNotifications()).toEqual([FAILURE_PREFIX]);
    expectNoLinks();
  });

  it('copes with a rejection that is not an Error', async () => {
    const file = writeFile(join(CLAUDE_DIR, 'commands', 'review.md'));
    (workspace.openTextDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(PAYLOAD);

    await send({ type: 'openFile', path: file });

    expect(shownNotifications()).toEqual([FAILURE_PREFIX]);
    expectNoLinks();
  });

  it('keeps the refusal of an outside file free of the path it was given', async () => {
    const file = writeFile(join(OUTSIDE_DIR, PAYLOAD.replace(/[:?]/g, '-'), 'x.md'));

    await send({ type: 'openFile', path: file });

    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expectNoLinks();
  });

  it('keeps the copy confirmation free of the text that was copied', async () => {
    await send({ type: 'copy', text: PAYLOAD });

    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expectNoLinks();
  });
});
