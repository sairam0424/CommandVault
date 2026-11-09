import { beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from 'vscode';
import {
  notifyError,
  notifyInfo,
  notifyWarn,
  safeNotificationText,
} from '../webview/notifications';
import { HOSTILE_NOTIFICATION_TEXTS } from './helpers/hostile-text';
import { linksIn, shownNotifications } from './helpers/notification-links';

const LINK = '[x](command:workbench.action.reloadWindow)';
const ELLIPSIS = '\u2026';
const MAX_TEXT_LENGTH = 200;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('safeNotificationText', () => {
  it.each([
    'review',
    'code_review',
    'review.md',
    'a*b~c',
    'CommandVault: 100% done',
    'say "hi" & \'bye\'',
    'naïve café 日本語',
  ])('leaves %s as it is', (text) => {
    expect(safeNotificationText(text)).toBe(text);
  });

  it.each([
    ['a name with parentheses', 'deploy (copy)'],
    ['a Windows path', 'C:\\Users\\me\\export.json'],
    ['a network share', '\\\\server\\share\\export.json'],
    ['an index', 'items[0] and items[1]'],
    ['a bracket, then a parenthesis a space away', 'draft [x] (final)'],
    ['a label with no target', '[docs]'],
    ['a target with no label', '(command:workbench.action.reloadWindow)'],
    ['angle brackets, a code span and an exclamation mark', 'a <b> `c` !d'],
    ['a trailing backslash', 'ends with a backslash \\'],
  ])('shows %s as it is, since none of it can make a link', (_name, text) => {
    expect(safeNotificationText(text)).toBe(text);
    expect(linksIn(safeNotificationText(text))).toEqual([]);
  });

  it('puts a space into the `](` that a link cannot do without, and changes nothing else', () => {
    expect(safeNotificationText('a[b](c)')).toBe('a[b] (c)');
    expect(safeNotificationText(LINK)).toBe('[x] (command:workbench.action.reloadWindow)');
    expect(safeNotificationText('](](')).toBe('] (] (');
    expect(safeNotificationText(']((')).toBe('] ((');
  });

  it.each(Object.entries(HOSTILE_NOTIFICATION_TEXTS))(
    'leaves no link and no link joint in %s',
    (_name, text) => {
      const safe = safeNotificationText(text);

      expect(linksIn(safe)).toEqual([]);
      expect(linksIn(`before ${safe} after`)).toEqual([]);
      expect(safe).not.toContain('](');
    },
  );

  it('does not let a link inside the text survive a cut in the middle of it', () => {
    const safe = safeNotificationText(`${'a'.repeat(190)}${LINK}`);

    expect(linksIn(safe)).toEqual([]);
    expect(safe).toMatch(/\u2026$/);
  });

  it.each([
    ['a newline', 'one\ntwo'],
    ['a carriage return', 'one\r\ntwo'],
    ['a tab', 'one\ttwo'],
    ['a NUL', 'one\u0000two'],
    ['a C1 control', 'one\u0085two'],
    ['a line separator', 'one\u2028two'],
    ['a paragraph separator', 'one\u2029two'],
    ['a no-break space', 'one\u00a0two'],
    ['a run of all of them', 'one \n\r\t\u0000\u2028 two'],
  ])('turns %s into one space', (_name, text) => {
    expect(safeNotificationText(text)).toBe('one two');
  });

  it('trims the text', () => {
    expect(safeNotificationText('\n  review  \t')).toBe('review');
  });

  it.each([
    ['a right-to-left override', 'invoice\u202egnp.exe'],
    ['a left-to-right embedding', 'invoice\u202agnp.exe'],
    ['a bidirectional isolate', 'invoice\u2067gnp.exe\u2069'],
    ['a zero-width space', 'invoice\u200bgnp.exe'],
    ['a word joiner', 'invoice\u2060gnp.exe'],
    ['a byte order mark', 'invoice\ufeffgnp.exe'],
    ['a soft hyphen', 'invoice\u00adgnp.exe'],
  ])('drops %s, which hides or reorders what the user reads', (_name, text) => {
    expect(safeNotificationText(text)).toBe(text.replace(/[^\x20-\x7e]/g, ''));
  });

  it('keeps the zero-width joiner and non-joiner, which spell some scripts and emoji', () => {
    expect(safeNotificationText('a\u200cb\u200dc')).toBe('a\u200cb\u200dc');
  });

  it('removes invisible characters before it looks for the joint, so one between ] and ( cannot hide it', () => {
    expect(safeNotificationText('[x]\u200b(c)')).toBe('[x] (c)');
  });

  describe('bound', () => {
    it('keeps text of 200 characters whole', () => {
      expect(safeNotificationText('A'.repeat(200))).toBe('A'.repeat(200));
    });

    it('cuts text of 201 characters to 200 and an ellipsis', () => {
      expect(safeNotificationText('A'.repeat(201))).toBe(`${'A'.repeat(200)}${ELLIPSIS}`);
    });

    it('cuts 10,000 characters to 200 and an ellipsis', () => {
      expect(safeNotificationText('A'.repeat(10_000))).toBe(`${'A'.repeat(200)}${ELLIPSIS}`);
    });

    it('counts the characters of the text, not the spaces it adds to the joints', () => {
      expect(safeNotificationText('['.repeat(300))).toBe(`${'['.repeat(200)}${ELLIPSIS}`);
      expect(safeNotificationText(']('.repeat(5_000)).length).toBeLessThanOrEqual(201);
    });

    it('does not cut a surrogate pair in half', () => {
      const safe = safeNotificationText(`${'A'.repeat(199)}\u{1F600}${'B'.repeat(10)}`);

      expect(safe).toBe(`${'A'.repeat(199)}${ELLIPSIS}`);
      expect(safe).not.toMatch(LONE_SURROGATE);
    });

    it('keeps a surrogate pair that ends exactly at the bound', () => {
      const safe = safeNotificationText(`${'A'.repeat(198)}\u{1F600}`);

      expect(safe).toBe(`${'A'.repeat(198)}\u{1F600}`);
    });
  });

  describe('a value that is not text', () => {
    it.each([
      ['undefined', undefined, ''],
      ['null', null, ''],
      ['a number', 42, '42'],
      ['a boolean', false, 'false'],
    ])('shows %s as %j', (_name, value, expected) => {
      expect(safeNotificationText(value as never)).toBe(expected);
    });

    it('neutralises the text form of an object', () => {
      const value = { toString: () => LINK };

      expect(linksIn(safeNotificationText(value as never))).toEqual([]);
    });
  });
});

describe('notifyInfo, notifyWarn and notifyError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['notifyInfo', notifyInfo, window.showInformationMessage],
    ['notifyWarn', notifyWarn, window.showWarningMessage],
    ['notifyError', notifyError, window.showErrorMessage],
  ])('%s shows the message with the matching severity', (_name, notify, shown) => {
    notify('CommandVault: hello');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('CommandVault: hello');
  });

  it('passes the buttons on and returns what the user picked', async () => {
    (window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Retry');

    const picked = await notifyInfo('CommandVault: hello', 'Retry', 'Cancel');

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'CommandVault: hello',
      'Retry',
      'Cancel',
    );
    expect(picked).toBe('Retry');
  });

  describe('last line of defence: a message that reaches them with a link in it', () => {
    it.each([
      ['notifyInfo', notifyInfo],
      ['notifyWarn', notifyWarn],
      ['notifyError', notifyError],
    ])('%s does not show the link', (_name, notify) => {
      notify(`CommandVault: ${LINK}`);

      expect(linksIn(shownNotifications().join('\n'))).toEqual([]);
    });

    it('keeps the joint of a link apart when safe text ending in ] is followed by the rest of a link', () => {
      const name = safeNotificationText('[x]');

      notifyInfo(`${name}(command:workbench.action.reloadWindow)`);

      expect(linksIn(shownNotifications()[0])).toEqual([]);
      expect(shownNotifications()[0]).not.toContain('](');
    });

    it('keeps every joint apart, not just the first', () => {
      notifyWarn(`${LINK} and ${LINK} and [y](https://attacker.example/x)`);

      expect(linksIn(shownNotifications()[0])).toEqual([]);
    });

    it('puts one space into a joint and changes nothing else', () => {
      notifyInfo('CommandVault: Exported 3 entries to C:\\Users\\me\\a[b](c)');

      expect(shownNotifications()).toEqual([
        'CommandVault: Exported 3 entries to C:\\Users\\me\\a[b] (c)',
      ]);
    });

    it('leaves a message without a joint exactly as it was', () => {
      notifyInfo('CommandVault: Exported 3 entries to [a] (b)');

      expect(shownNotifications()).toEqual(['CommandVault: Exported 3 entries to [a] (b)']);
    });
  });
});

describe('whatever is put together, no link survives', () => {
  const PIECES = [
    '[',
    ']',
    '(',
    ')',
    '\\',
    ' ',
    '\n',
    'command:',
    'workbench.action.reloadWindow',
    'https://',
    'file:',
    'x',
    '"',
    '!',
    '<',
    '>',
    '`',
    '%5B',
    '%28',
    '\u200b',
    '\u202e',
  ];
  const TEXTS = 2_000;
  const MAX_PIECES = 24;

  /** mulberry32: the same sequence on every run, so a failure can be reproduced. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  function someTexts(seed: number): readonly string[] {
    const next = random(seed);
    return Array.from({ length: TEXTS }, () =>
      Array.from(
        { length: 1 + Math.floor(next() * MAX_PIECES) },
        () => PIECES[Math.floor(next() * PIECES.length)],
      ).join(''),
    );
  }

  const first = someTexts(1);
  const second = someTexts(2);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('safeNotificationText alone is never a link, alone or between other text', () => {
    for (const text of first) {
      const safe = safeNotificationText(text);
      expect(linksIn(safe)).toEqual([]);
      expect(linksIn(`before "${safe}" after`)).toEqual([]);
    }
  });

  it('safeNotificationText leaves every bracket, parenthesis, angle bracket, backtick, bang and backslash where it was', () => {
    const MARKUP = /[\\[\]()<>`!]/g;
    const uncut = first.filter((text) => text.length <= MAX_TEXT_LENGTH);

    expect(uncut.length).toBeGreaterThan(TEXTS / 4);
    for (const text of uncut) {
      expect(safeNotificationText(text).match(MARKUP) ?? []).toEqual(text.match(MARKUP) ?? []);
    }
  });

  it.each([
    ['one text', (a: string) => a],
    ['two texts side by side', (a: string, b: string) => `${a}${b}`],
    ['a text in parentheses after another', (a: string, b: string) => `${a}(${b})`],
    ['the pieces of a link around two texts', (a: string, b: string) => `[${a}](${b})`],
    ['a text after a joint', (a: string, b: string) => `${a}](${b}`],
  ])('%s, after safeNotificationText, through notifyInfo', (_name, compose) => {
    for (const [index, text] of first.entries()) {
      notifyInfo(compose(safeNotificationText(text), safeNotificationText(second[index])));
    }

    const shown = shownNotifications();
    expect(shown).toHaveLength(TEXTS);
    expect(shown.flatMap(linksIn)).toEqual([]);
  });
});
