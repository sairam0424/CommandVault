import { describe, it, expect, vi } from 'vitest';
import { posix } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { CommandError, EXIT_RUNTIME_ERROR } from '../errors.js';
import {
  openInEditor,
  planInvocation,
  quoteForCmd,
  resolveEditorCandidates,
  splitCommandLine,
  type SpawnEditor,
} from '../editor.js';

const FILE = '/vault/skills/demo/SKILL.md';

function exited(status: number): SpawnSyncReturns<Buffer> {
  return { status, signal: null, error: undefined } as unknown as SpawnSyncReturns<Buffer>;
}

function failedToStart(code: string): SpawnSyncReturns<Buffer> {
  const error = Object.assign(new Error(`spawn ${code}`), { code });
  return { status: null, signal: null, error } as unknown as SpawnSyncReturns<Buffer>;
}

describe('splitCommandLine', () => {
  it('splits on whitespace', () => {
    expect(splitCommandLine('code --wait', 'linux')).toEqual(['code', '--wait']);
    expect(splitCommandLine('  vim   -n  ', 'linux')).toEqual(['vim', '-n']);
  });

  it('keeps a quoted part together, with its spaces', () => {
    expect(splitCommandLine(`vim -c "set ts=2 sw=2"`, 'linux')).toEqual([
      'vim',
      '-c',
      'set ts=2 sw=2',
    ]);
    expect(splitCommandLine(`'/Applications/My Editor/bin/ed' -w`, 'linux')).toEqual([
      '/Applications/My Editor/bin/ed',
      '-w',
    ]);
  });

  it('honours a backslash before a space or a quote on POSIX', () => {
    expect(splitCommandLine('my\\ editor --flag', 'linux')).toEqual(['my editor', '--flag']);
    expect(splitCommandLine('echo "say \\"hi\\""', 'linux')).toEqual(['echo', 'say "hi"']);
  });

  it('treats a backslash as a path separator on Windows', () => {
    expect(
      splitCommandLine('"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait', 'win32'),
    ).toEqual(['C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', '--wait']);
    expect(splitCommandLine('C:\\tools\\vim.exe -n', 'win32')).toEqual([
      'C:\\tools\\vim.exe',
      '-n',
    ]);
  });

  it('keeps an empty quoted argument', () => {
    expect(splitCommandLine(`tool "" x`, 'linux')).toEqual(['tool', '', 'x']);
  });

  it('rejects an unterminated quote with an error that names the problem', () => {
    expect(() => splitCommandLine('vim "oops', 'linux')).toThrow(/unterminated/i);
  });

  it('returns no parts for blank text', () => {
    expect(splitCommandLine('   ', 'linux')).toEqual([]);
  });
});

describe('resolveEditorCandidates', () => {
  it('prefers $VISUAL over $EDITOR', () => {
    const found = resolveEditorCandidates({ VISUAL: 'nano -l', EDITOR: 'vi' }, 'linux');
    expect(found.isConfigured).toBe(true);
    expect(found.candidates).toEqual([['nano', '-l']]);
  });

  it('uses $EDITOR when $VISUAL is unset or blank', () => {
    expect(resolveEditorCandidates({ EDITOR: 'code --wait' }, 'linux').candidates).toEqual([
      ['code', '--wait'],
    ]);
    expect(resolveEditorCandidates({ VISUAL: '  ', EDITOR: 'vi' }, 'linux').candidates).toEqual([
      ['vi'],
    ]);
  });

  it('falls back to code, then vi, when neither is set', () => {
    const found = resolveEditorCandidates({}, 'linux');
    expect(found.isConfigured).toBe(false);
    expect(found.candidates).toEqual([['code'], ['vi']]);
  });

  it('falls back to code, then notepad, on Windows', () => {
    expect(resolveEditorCandidates({}, 'win32').candidates).toEqual([['code'], ['notepad']]);
  });

  it('names the variable when its value cannot be parsed', () => {
    expect(() => resolveEditorCandidates({ EDITOR: 'vim "x' }, 'linux')).toThrow(
      /\$EDITOR.*unterminated/is,
    );
  });
});

describe('planInvocation', () => {
  const never = () => false;

  it('appends the absolute file path to the editor arguments', () => {
    const plan = planInvocation(['code', '--wait'], FILE, 'linux', {}, never);
    expect(plan).toMatchObject({
      command: 'code',
      args: ['--wait', posix.resolve(FILE)],
      shell: false,
    });
  });

  it('runs a Windows .cmd through the shell, quoting every part', () => {
    const plan = planInvocation(
      ['C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', '--wait'],
      'C:\\My Notes\\skill.md',
      'win32',
      {},
      never,
    );
    expect(plan.shell).toBe(true);
    expect(plan.command).toBe('"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"');
    expect(plan.args).toEqual(['"--wait"', '"C:\\My Notes\\skill.md"']);
  });

  it('runs a Windows .bat through the shell too', () => {
    expect(planInvocation(['edit.bat'], 'C:\\a.md', 'win32', {}, never).shell).toBe(true);
  });

  it('does not use the shell for a Windows .exe', () => {
    const plan = planInvocation(['C:\\tools\\vim.exe', '-n'], 'C:\\a.md', 'win32', {}, never);
    expect(plan.shell).toBe(false);
    expect(plan.command).toBe('C:\\tools\\vim.exe');
  });

  it('finds a bare "code" on Windows through PATH and PATHEXT, as code.cmd', () => {
    // the Windows file system ignores case, so PATHEXT's ".CMD" finds code.cmd
    const exists = (candidate: string) => candidate.toLowerCase() === 'c:\\vscode\\bin\\code.cmd';
    const env = { PATH: 'C:\\Windows;C:\\VSCode\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const plan = planInvocation(['code', '--wait'], 'C:\\a.md', 'win32', env, exists);
    expect(plan.shell).toBe(true);
    expect(plan.command.toLowerCase()).toBe('"c:\\vscode\\bin\\code.cmd"');
  });

  it('leaves a bare command alone on Windows when PATH has no match', () => {
    const plan = planInvocation(['nvim'], 'C:\\a.md', 'win32', { PATH: 'C:\\Windows' }, never);
    expect(plan).toMatchObject({ command: 'nvim', shell: false });
  });
});

describe('openInEditor', () => {
  const base = { platform: 'linux' as const };

  it('runs the editor with its own arguments and the file, on the inherited terminal', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(exited(0));

    openInEditor(FILE, { ...base, env: { EDITOR: 'code --wait' }, spawn });

    expect(spawn).toHaveBeenCalledWith('code', ['--wait', posix.resolve(FILE)], {
      stdio: 'inherit',
      shell: false,
    });
  });

  it('uses $VISUAL before $EDITOR', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(exited(0));

    openInEditor(FILE, { ...base, env: { VISUAL: 'nano', EDITOR: 'vi' }, spawn });

    expect(spawn.mock.calls[0]?.[0]).toBe('nano');
  });

  it('fails with exit 1 and names the editor when it does not exist', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(failedToStart('ENOENT'));

    const attempt = () => openInEditor(FILE, { ...base, env: { EDITOR: 'nope --x' }, spawn });

    expect(attempt).toThrow(CommandError);
    expect(attempt).toThrow(/failed to open editor \(nope --x\).*not found/);
    try {
      attempt();
    } catch (err) {
      expect((err as CommandError).exitCode).toBe(EXIT_RUNTIME_ERROR);
      expect((err as CommandError).hint).toMatch(/\$VISUAL or \$EDITOR/);
    }
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('does not fall back to another editor when the configured one is missing', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(failedToStart('ENOENT'));

    expect(() => openInEditor(FILE, { ...base, env: { EDITOR: 'nope' }, spawn })).toThrow(
      CommandError,
    );
    expect(spawn.mock.calls.map((call) => call[0])).toEqual(['nope']);
  });

  it('fails when the editor exits non-zero', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(exited(3));

    expect(() => openInEditor(FILE, { ...base, env: { EDITOR: 'vi' }, spawn })).toThrow(
      /exited with status 3/,
    );
  });

  it('fails when the editor is killed by a signal', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue({
      status: null,
      signal: 'SIGKILL',
    } as unknown as SpawnSyncReturns<Buffer>);

    expect(() => openInEditor(FILE, { ...base, env: { EDITOR: 'vi' }, spawn })).toThrow(/SIGKILL/);
  });

  it('reports a permission error as such', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(failedToStart('EACCES'));

    expect(() => openInEditor(FILE, { ...base, env: { EDITOR: './ed' }, spawn })).toThrow(
      /permission denied/i,
    );
  });

  it('tries code, then vi, when nothing is configured', () => {
    const spawn = vi
      .fn<SpawnEditor>()
      .mockReturnValueOnce(failedToStart('ENOENT'))
      .mockReturnValueOnce(exited(0));

    openInEditor(FILE, { ...base, env: {}, spawn });

    expect(spawn.mock.calls.map((call) => call[0])).toEqual(['code', 'vi']);
  });

  it('says what it tried when no editor at all can start', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(failedToStart('ENOENT'));

    expect(() => openInEditor(FILE, { ...base, env: {}, spawn })).toThrow(
      /no editor found \(tried code, vi\)/,
    );
  });

  it('does not try the next fallback after an editor that started and failed', () => {
    const spawn = vi.fn<SpawnEditor>().mockReturnValue(exited(1));

    expect(() => openInEditor(FILE, { ...base, env: {}, spawn })).toThrow(/exited with status 1/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('quoteForCmd', () => {
  it.each([
    ['plain text', 'a b', '"a b"'],
    ['the empty string', '', '""'],
    ['backslashes that precede nothing special', 'C:\\dir\\file.md', '"C:\\dir\\file.md"'],
    ['a double quote', 'say "hi"', '"say \\"hi\\""'],
    ['one backslash before a quote (doubled, quote escaped)', 'a\\"b', '"a\\\\\\"b"'],
    ['two backslashes before a quote', 'a\\\\"b', '"a\\\\\\\\\\"b"'],
    [
      'a trailing backslash (doubled so it cannot escape the closing quote)',
      'C:\\dir\\',
      '"C:\\dir\\\\"',
    ],
    ['trailing backslashes and a quote', 'x\\"y\\\\', '"x\\\\\\"y\\\\\\\\"'],
  ])('quotes %s', (_name, input, expected) => {
    expect(quoteForCmd(input)).toBe(expected);
  });
});
