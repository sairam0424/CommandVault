/**
 * Text a third party can put in a plugin or a `vault sync` bundle and so into an entry's name,
 * description, tags or content. Each one aims at a different way a markdown renderer or an HTML
 * page can be made to act on text that should only ever be displayed.
 */
export const HOSTILE_TEXTS: Readonly<Record<string, string>> = {
  commandLink:
    '[run](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22touch%20pwned%5Cn%22%7D)',
  commandAutolink:
    '<command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22touch%20pwned%22%7D>',
  commandReference: '[run][1]\n\n[1]: command:workbench.action.openSettingsJson',
  remoteImage: '![tracker](https://attacker.example/pixel.png)',
  externalLink: '[docs](https://attacker.example/login)',
  bareUrl: 'see https://attacker.example/login or www.attacker.example',
  htmlInjection: '<img src=x onerror=alert(1)><script>alert(1)</script>',
  blockStructure: 'ok\n\n# heading\n\n- item\n\n> quote\n\n---\n\n| a | b |\n|---|---|',
  trailingBackslash: 'ends with a backslash \\',
};

/** Characters a CommonMark/GFM renderer can read as markup (a superset of what must be escaped). */
const MARKUP_CHARACTER = /[\\`*_{}[\]()<>#+\-.!|~&:=@]/;

/**
 * Where `text` has markup a renderer would act on. A backslash escapes the markup character after
 * it; any other backslash, and any markup character not escaped that way, is reported. Empty means
 * a renderer can only display `text`.
 */
export function unescapedMarkup(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '\\' && next !== undefined && MARKUP_CHARACTER.test(next)) {
      index += 1;
    } else if (char === '\\' || MARKUP_CHARACTER.test(char)) {
      found.push(`${char}@${index}`);
    }
  }
  return found;
}

/** The text a provider interpolated between two sentinels that cannot occur in the payload. */
export function between(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (from === -1 || to === -1) {
    throw new Error(`"${start}" ... "${end}" not found in: ${value}`);
  }
  return value.slice(from + start.length, to);
}

const RUN_ID = 'command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22id%22%7D';

/**
 * Text that becomes a button in a VS Code notification if it reaches `showInformationMessage` (or
 * the warning/error twin) unescaped: the renderer turns `[label](command:...)`, `https:` and `file:`
 * into links and runs `command:` ones with commands allowed. Every value here is a name, a path or an
 * error message that a plugin or a cloned repository can supply. The percent-encoded forms are inert
 * in the notification itself (nothing decodes them there) and are here to pin that they stay inert.
 */
export const HOSTILE_NOTIFICATION_TEXTS: Readonly<Record<string, string>> = {
  commandLink: `[x](${RUN_ID})`,
  commandLinkWithTitle: '[x](command:workbench.action.reloadWindow "Reload")',
  labelWithBracket: '[[x](command:workbench.action.reloadWindow)',
  nestedParentheses: '[x]((command:workbench.action.reloadWindow))',
  externalLink: '[docs](https://attacker.example/login)',
  fileLink: '[passwd](file:///etc/passwd)',
  markdownImage: '![pixel](https://attacker.example/pixel.png)',
  autolink: '<command:workbench.action.reloadWindow>',
  percentEncodedBrackets: `%5Bx%5D%28${RUN_ID.replace(/%/g, '%25')}%29`,
  newlineInsideLink: '[x]\n(command:workbench.action.reloadWindow)',
  newlineInsideTarget: '[x](\ncommand:workbench.action.reloadWindow)',
  lineSeparator: '[x]\u2028(command:workbench.action.reloadWindow)',
  zeroWidthJoint: '[x]\u200b(command:workbench.action.reloadWindow)',
  bidiOverride: 'invoice\u202egnp.exe [x](command:workbench.action.reloadWindow)',
  endsInBracket: 'draft [x]',
  startsWithParenthesis: '(command:workbench.action.reloadWindow)',
  danglingBackslash: 'ends with a backslash \\',
  backslashBeforeBracket: '\\[x](command:workbench.action.reloadWindow)',
  linkPastTheBound: `${'a'.repeat(190)}[x](${RUN_ID})`,
  tenThousandCharacters: 'A'.repeat(10_000),
  tenThousandCharactersEndingInALink: `${'A'.repeat(10_000)}[x](${RUN_ID})`,
};
