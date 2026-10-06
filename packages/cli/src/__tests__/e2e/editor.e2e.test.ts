import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  IS_WINDOWS,
  context,
  createSandbox,
  expectSuccess,
  parseJson,
  type Sandbox,
} from './harness.js';

/**
 * `vault open` against the BUILT binary with a stub editor that records the arguments it got.
 * The stub is a shell script, so these run on POSIX only; the Windows launch rules are covered by
 * the planInvocation unit tests.
 */

vi.setConfig({ testTimeout: 60_000 });

let box: Sandbox;

beforeEach(() => {
  box = createSandbox();
});

afterEach(() => {
  box.dispose();
});

const loggedArguments = (): string[] => readFileSync(box.editorLog, 'utf8').trimEnd().split('\n');

const skillPath = () => join(box.home, '.claude', 'skills', 'demo-skill', 'SKILL.md');

// Only the sqlite tier reads the stored usage count back. Its query syntax treats a hyphen as an
// operator, so search for the first word of the name and pick the entry out of the hits.
function usageOf(name: string): number {
  const firstWord = name.split('-')[0] ?? name;
  const result = box.run(['search', firstWord, '--tier', 'sqlite', '--json']);
  const found = parseJson<{ results: { entry: { name: string; usageCount: number } }[] }>(result);
  return found.results.find((hit) => hit.entry.name === name)?.entry.usageCount ?? -1;
}

describe.skipIf(IS_WINDOWS)('vault open: the editor command', () => {
  it('passes the arguments written in $EDITOR, then the file', () => {
    const result = box.run(['open', 'demo-skill'], { EDITOR: `${box.editorStub} --wait -n` });

    expectSuccess(result);
    expect(loggedArguments()).toEqual(['--wait', '-n', skillPath()]);
  });

  it('respects quotes in $EDITOR', () => {
    const result = box.run(['open', 'demo-skill'], {
      EDITOR: `"${box.editorStub}" --title "two words" 'single quoted'`,
    });

    expectSuccess(result);
    expect(loggedArguments()).toEqual(['--title', 'two words', 'single quoted', skillPath()]);
  });

  it('starts an editor whose path contains a space', () => {
    const spaced = join(dirname(box.editorStub), 'my editors', 'ed.sh');
    mkdirSync(dirname(spaced), { recursive: true });
    copyFileSync(box.editorStub, spaced);
    chmodSync(spaced, 0o755);

    const result = box.run(['open', 'demo-skill'], { EDITOR: `"${spaced}" --flag` });

    expectSuccess(result);
    expect(loggedArguments()).toEqual(['--flag', skillPath()]);
  });

  it('prefers $VISUAL over $EDITOR', () => {
    const result = box.run(['open', 'demo-skill'], {
      VISUAL: `${box.editorStub} --from-visual`,
      EDITOR: `${box.editorStub} --from-editor`,
    });

    expectSuccess(result);
    expect(loggedArguments()[0]).toBe('--from-visual');
  });

  it('counts the open as a use when the editor succeeds', () => {
    expect(usageOf('demo-skill')).toBe(0);

    expectSuccess(box.run(['open', 'demo-skill']));

    expect(usageOf('demo-skill')).toBe(1);
  });
});

describe.skipIf(IS_WINDOWS)('vault open: failures', () => {
  it('exits 1, says why and records no use when the editor exits non-zero', () => {
    const failing = join(dirname(box.editorStub), 'fail.sh');
    writeFileSync(failing, '#!/bin/sh\nexit 3\n');
    chmodSync(failing, 0o755);

    const result = box.run(['open', 'demo-skill'], { EDITOR: failing });

    expect(result.status, context(result)).toBe(1);
    expect(result.stderr, context(result)).toMatch(
      /^error: editor \(.*fail\.sh\) exited with status 3$/m,
    );
    expect(usageOf('demo-skill')).toBe(0);
  });

  it('exits 1 and names what it tried when no editor can start', () => {
    const result = box.run(['open', 'demo-skill'], {
      EDITOR: '',
      VISUAL: '',
      PATH: dirname(process.execPath),
    });

    expect(result.status, context(result)).toBe(1);
    expect(result.stderr, context(result)).toMatch(/^error: no editor found \(tried code, vi\)$/m);
    expect(result.stderr, context(result)).toMatch(/^hint: set \$VISUAL or \$EDITOR/m);
    expect(usageOf('demo-skill')).toBe(0);
  });

  it('exits 1 with one line when $EDITOR has an unterminated quote', () => {
    const result = box.run(['open', 'demo-skill'], { EDITOR: 'vim "oops' });

    expect(result.status, context(result)).toBe(1);
    expect(result.stderr, context(result)).toMatch(/^error: \$EDITOR is not a valid command line/m);
  });
});
