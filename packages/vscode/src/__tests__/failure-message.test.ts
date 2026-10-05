import { describe, expect, it } from 'vitest';
import { failureMessage } from '../webview/failure-message';

const ACTION = 'Could not open file';

const LINK_PAYLOAD = '[a](command:workbench.action.reloadWindow)';

/** A `code` whose string form is a valid code the first time it is read and a link afterwards. */
function codeThatChangesItsMind(): { toString: () => string } {
  let reads = 0;
  return { toString: () => (reads++ === 0 ? 'ENOENT' : LINK_PAYLOAD) };
}

describe('failureMessage', () => {
  it.each(['ENOENT', 'EACCES', 'ERR_FS_EISDIR', 'E2BIG'])('names the error code %s', (code) => {
    const err = Object.assign(new Error('boom'), { code });

    expect(failureMessage(ACTION, err)).toBe(`CommandVault: ${ACTION} (${code})`);
  });

  it('never repeats the error message, which carries the path', () => {
    const err = Object.assign(new Error("ENOENT: no such file, realpath '/x/[a](command:b)'"), {
      code: 'ENOENT',
    });

    expect(failureMessage(ACTION, err)).not.toContain('/x/');
  });

  it.each([
    ['a lower-case code', { code: 'enoent' }],
    ['a code with link syntax', { code: '[a](command:workbench.action.reloadWindow)' }],
    ['a code with a space', { code: 'E NOENT' }],
    ['a code that is one letter', { code: 'E' }],
    ['a code that is far too long', { code: 'E'.repeat(64) }],
    ['a code that is a number', { code: 2 }],
    // A non-string whose String() form looks like a code: only the typeof check stops these.
    ['a code that is an array', { code: ['ENOENT'] }],
    ['a code that is a String object', { code: new String('ENOENT') }],
    ['a code that is an object with a toString', { code: { toString: () => 'ENOENT' } }],
    ['a code whose toString changes between reads', { code: codeThatChangesItsMind() }],
    ['an error without a code', new Error('plain')],
    ['a string', 'ENOENT'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('leaves the code out for %s', (_label, err) => {
    expect(failureMessage(ACTION, err)).toBe(`CommandVault: ${ACTION}`);
  });
});
