import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { window, workspace } from 'vscode';
import { configurationWith } from './helpers/vscode-extras';
import type { SettingScopes } from './helpers/vscode-extras';
import { openPanelHandler } from './helpers/panel-handler';

const ASSISTANT_DIRS = ['.claude', '.cursor', '.continue', '.claude-evil'];
const OUTSIDE_MESSAGE = 'CommandVault: Cannot open file outside allowed directories';

function writeFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# entry\n');
  return path;
}

describe('Detail panel: opening the source file', () => {
  let sandbox: string;
  let savedClaudeDir: string | undefined;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  const home = homedir();

  beforeEach(() => {
    vi.clearAllMocks();
    savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    sandbox = mkdtempSync(join(home, 'open-file-'));
    setClaudeConfigPathSetting({});
  });

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', savedClaudeDir);
    restoreEnv('HOME', savedHome);
    restoreEnv('USERPROFILE', savedUserProfile);
    for (const dir of [sandbox, ...ASSISTANT_DIRS.map((name) => join(home, name))]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function send(path: unknown): Promise<void> {
    const handler = openPanelHandler();
    await handler({ type: 'openFile', path });
  }

  function expectOpened(file: string): void {
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(workspace.openTextDocument).toHaveBeenCalledTimes(1);
    const uri = (workspace.openTextDocument as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The native binding, like fs.promises.realpath in production: the JS realpathSync keeps a
    // Windows 8.3 short name (RUNNER~1) that the native one expands.
    expect(uri.fsPath).toBe(realpathSync.native(file));
    expect(window.showTextDocument).toHaveBeenCalledTimes(1);
  }

  function expectRefused(): void {
    expect(window.showErrorMessage).toHaveBeenCalledWith(OUTSIDE_MESSAGE);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  }

  describe('allowed directories', () => {
    it('opens a file under ~/.claude', async () => {
      const file = writeFile(join(home, '.claude', 'skills', 'review.md'));

      await send(file);

      expectOpened(file);
    });

    it('opens a file under the directory CLAUDE_CONFIG_DIR names', async () => {
      const custom = join(sandbox, 'claude-elsewhere');
      process.env.CLAUDE_CONFIG_DIR = custom;
      const file = writeFile(join(custom, 'skills', 'review.md'));

      await send(file);

      expectOpened(file);
    });

    it('reads CLAUDE_CONFIG_DIR when the message arrives, not when the module loaded', async () => {
      const handler = openPanelHandler();
      const custom = join(sandbox, 'set-after-load');
      process.env.CLAUDE_CONFIG_DIR = custom;
      const file = writeFile(join(custom, 'agents', 'deploy.md'));

      await handler({ type: 'openFile', path: file });

      expectOpened(file);
    });

    it('reads the home directory when the message arrives, not when the module loaded', async () => {
      const handler = openPanelHandler();
      const otherHome = join(sandbox, 'other-home');
      moveHome(otherHome);
      const file = writeFile(join(otherHome, '.cursor', 'rules', 'style.md'));

      await handler({ type: 'openFile', path: file });

      expectOpened(file);
    });

    it.each(['.cursor', '.continue'])(
      'opens a file under ~/%s even when ~/.claude is absent',
      async (dir) => {
        const file = writeFile(join(home, dir, 'rules', 'style.md'));

        await send(file);

        expectOpened(file);
      },
    );

    it.each([
      ['a file whose name starts with two dots', ['..notes.md']],
      ['a file in a directory whose name starts with two dots', ['..hidden', 'notes.md']],
    ])('opens %s, which is below the directory and not a way out of it', async (_label, parts) => {
      const file = writeFile(join(home, '.claude', ...parts));

      await send(file);

      expectOpened(file);
    });

    it('opens a file reached through a symlinked allowed directory', async () => {
      const dotfiles = join(sandbox, 'dotfiles', 'claude');
      const file = writeFile(join(dotfiles, 'skills', 'review.md'));
      symlinkSync(dotfiles, join(home, '.claude'));

      await send(join(home, '.claude', 'skills', 'review.md'));

      expectOpened(file);
    });
  });

  describe('refused paths', () => {
    beforeEach(() => {
      // All three exist, so the path under test is the only thing that can decide the outcome.
      for (const name of ['.claude', '.cursor', '.continue']) {
        mkdirSync(join(home, name), { recursive: true });
      }
    });

    it('refuses a file outside every allowed directory, saying so', async () => {
      const file = writeFile(join(sandbox, 'notes', 'secret.md'));

      await send(file);

      expectRefused();
    });

    it('refuses a sibling whose name starts with the allowed directory name', async () => {
      const file = writeFile(`${join(home, '.claude')}-evil/skills/review.md`);

      await send(file);

      expectRefused();
    });

    it('refuses a symlink inside an allowed directory that points outside', async () => {
      const secret = writeFile(join(sandbox, 'secret', 'token.md'));
      const link = join(home, '.claude', 'skills', 'innocent.md');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(secret, link);

      await send(link);

      expectRefused();
    });

    it('refuses a symlinked directory inside an allowed directory that points outside', async () => {
      writeFile(join(sandbox, 'secret', 'token.md'));
      symlinkSync(join(sandbox, 'secret'), join(home, '.claude', 'linked'));

      await send(join(home, '.claude', 'linked', 'token.md'));

      expectRefused();
    });

    it('refuses a path that climbs out of an allowed directory with ..', async () => {
      writeFile(join(sandbox, 'secret.md'));
      const climbing = `${home}/.claude/skills/../../${basename(sandbox)}/secret.md`;

      await send(climbing);

      expectRefused();
    });

    it('refuses the allowed directory itself, which is not a file below it', async () => {
      await send(join(home, '.claude'));

      expectRefused();
    });

    it.each([
      ['its parent, the home directory', () => home],
      ['its grandparent', () => dirname(home)],
    ])('refuses %s, which holds the allowed directory and is not below it', async (_label, dir) => {
      await send(dir());

      expectRefused();
    });

    it('reports a missing file inside an allowed directory as an error', async () => {
      await send(join(home, '.claude', 'skills', 'does-not-exist.md'));

      expect(workspace.openTextDocument).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(window.showErrorMessage).not.toHaveBeenCalledWith(OUTSIDE_MESSAGE);
    });

    it.each([
      ['a relative path', 'skills/review.md'],
      ['a number', 42],
      ['an object', { toString: () => join(homedir(), '.claude', 'x.md') }],
    ])('refuses %s, saying so', async (_label, path) => {
      writeFile(join(home, '.claude', 'skills', 'review.md'));

      await send(path);

      expectRefused();
    });

    it('does not resolve a relative path against the current directory', async () => {
      const file = writeFile(join(home, '.claude', 'skills', 'review.md'));
      const cwd = process.cwd();
      process.chdir(join(home, '.claude'));

      try {
        await send('skills/review.md');
      } finally {
        process.chdir(cwd);
      }

      expect(existsSync(file)).toBe(true);
      expectRefused();
    });
  });

  describe('the commandvault.claudeConfigPath setting', () => {
    it('opens a file under the directory the user settings name', async () => {
      const custom = join(sandbox, 'claude-from-settings');
      setClaudeConfigPathSetting({ globalValue: custom });
      const file = writeFile(join(custom, 'skills', 'review.md'));

      await send(file);

      expectOpened(file);
    });

    it('still refuses a file outside that directory', async () => {
      const custom = join(sandbox, 'claude-from-settings');
      setClaudeConfigPathSetting({ globalValue: custom });
      mkdirSync(custom, { recursive: true });
      const file = writeFile(join(sandbox, 'notes', 'secret.md'));

      await send(file);

      expectRefused();
    });

    it('ignores a value a workspace sets, which whoever wrote the repository controls', async () => {
      const custom = join(sandbox, 'claude-from-workspace');
      setClaudeConfigPathSetting({ workspaceValue: custom, workspaceFolderValue: custom });
      const file = writeFile(join(custom, 'skills', 'review.md'));

      await send(file);

      expectRefused();
    });

    it('ignores a relative value, which would resolve against the editor working directory', async () => {
      setClaudeConfigPathSetting({ globalValue: '.' });
      const file = writeFile(join(sandbox, 'notes', 'secret.md'));
      const cwd = process.cwd();
      process.chdir(sandbox);

      try {
        await send(file);
      } finally {
        process.chdir(cwd);
      }

      expectRefused();
    });

    it.each([
      ['an empty value', ''],
      ['blanks', '   '],
      ['a number', 42],
    ])('ignores %s and keeps the other directories', async (_label, globalValue) => {
      setClaudeConfigPathSetting({ globalValue });
      const file = writeFile(join(home, '.cursor', 'rules', 'style.md'));

      await send(file);

      expectOpened(file);
    });
  });

  describe('when some allowed directories do not exist', () => {
    it('still refuses an outside file, saying so, when only ~/.claude exists', async () => {
      mkdirSync(join(home, '.claude'), { recursive: true });
      const file = writeFile(join(sandbox, 'notes', 'secret.md'));
      expect(existsSync(join(home, '.cursor'))).toBe(false);

      await send(file);

      expectRefused();
    });

    it('still refuses an outside file, saying so, when none of them exist', async () => {
      const file = writeFile(join(sandbox, 'notes', 'secret.md'));
      expect(existsSync(join(home, '.claude'))).toBe(false);

      await send(file);

      expectRefused();
    });
  });

  describe('when another allowed directory cannot be read', () => {
    it('is not blocked by a CLAUDE_CONFIG_DIR below a regular file (ENOTDIR)', async () => {
      const blocker = writeFile(join(sandbox, 'a-file'));
      process.env.CLAUDE_CONFIG_DIR = join(blocker, 'claude');
      const file = writeFile(join(home, '.cursor', 'rules', 'style.md'));

      await send(file);

      expectOpened(file);
    });

    it('is not blocked by a symlink loop (ELOOP)', async () => {
      symlinkSync(join(home, '.cursor'), join(home, '.cursor'));
      const file = writeFile(join(home, '.continue', 'rules', 'style.md'));

      await send(file);

      expectOpened(file);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'is not blocked by a directory it may not enter (EACCES)',
      async () => {
        const locked = join(sandbox, 'locked');
        mkdirSync(join(locked, 'inner'), { recursive: true });
        symlinkSync(join(locked, 'inner'), join(home, '.cursor'));
        chmodSync(locked, 0o000);
        const file = writeFile(join(home, '.continue', 'rules', 'style.md'));

        try {
          await send(file);
        } finally {
          chmodSync(locked, 0o700);
        }

        expectOpened(file);
      },
    );
  });

  describe('when a directory cannot be resolved for an unexpected reason', () => {
    it.skipIf(process.platform === 'win32')(
      'reports the error instead of guessing that the file is outside',
      async () => {
        process.env.CLAUDE_CONFIG_DIR = `/${'a'.repeat(5000)}`;
        const file = writeFile(join(home, '.cursor', 'rules', 'style.md'));

        await send(file);

        expect(workspace.openTextDocument).not.toHaveBeenCalled();
        expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
        expect(window.showErrorMessage).toHaveBeenCalledWith(
          'CommandVault: Could not open file (ENAMETOOLONG)',
        );
      },
    );
  });

  it('still copies text to the clipboard', async () => {
    const { env } = await import('vscode');
    const handler = openPanelHandler();

    await handler({ type: 'copy', text: 'review' });

    expect(env.clipboard.writeText).toHaveBeenCalledWith('review');
  });
});

/** os.homedir() reads HOME on POSIX and USERPROFILE on Windows: a test that moves it moves both. */
function moveHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function setClaudeConfigPathSetting(scopes: SettingScopes): void {
  (workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(
    configurationWith(scopes),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
