/**
 * The parts of the `vscode` API the hover and link providers use, which the shared shim in
 * src/__mocks__/vscode.ts leaves out. Each test file layers these over that shim:
 *
 *   vi.mock('vscode', async (importOriginal) =>
 *     (await import('./helpers/vscode-extras')).withVscodeExtras(await importOriginal()));
 *
 * Uri copies what matters for security from vscode-uri 3.2.0 (the percent-encoding of the path
 * and of the authority, the lower-cased drive letter, and the two ways it throws) instead of being
 * made convenient, so that a test fails on the same inputs the real editor would mishandle;
 * vscode-uri-shim.test.ts pins its output to the library's. MarkdownString implements only what the
 * providers call, so a provider that reaches for another method fails loudly instead of passing.
 */

export type TrustedCommands = boolean | { readonly enabledCommands: readonly string[] };

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

export class MarkdownString {
  value: string;
  isTrusted?: TrustedCommands;
  supportHtml = false;
  supportThemeIcons = false;

  constructor(value = '') {
    this.value = value;
  }

  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export class Hover {
  readonly contents: readonly (MarkdownString | string)[];

  constructor(
    contents: MarkdownString | string | readonly (MarkdownString | string)[],
    readonly range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents as MarkdownString | string];
  }
}

/** Which characters, besides the unreserved ones, vscode-uri leaves alone in a part of a URI. */
type UriPart = 'component' | 'path' | 'authority';
const URI_UNRESERVED = /[A-Za-z0-9\-._~]/;
const URI_KEPT: Readonly<Record<UriPart, string>> = {
  component: '',
  path: '/',
  authority: '[]:',
};

function encodeUriPart(text: string, part: UriPart): string {
  return Array.from(text)
    .map((char) => {
      if (URI_UNRESERVED.test(char) || URI_KEPT[part].includes(char)) return char;
      const encoded = encodeURIComponent(char);
      return encoded === char ? `%${char.charCodeAt(0).toString(16).toUpperCase()}` : encoded;
    })
    .join('');
}

function formatUserinfo(userinfo: string): string {
  const passwordAt = userinfo.lastIndexOf(':');
  if (passwordAt === -1) return encodeUriPart(userinfo, 'component');
  const user = encodeUriPart(userinfo.slice(0, passwordAt), 'component');
  return `${user}:${encodeUriPart(userinfo.slice(passwordAt + 1), 'authority')}`;
}

function formatHost(host: string): string {
  const portAt = host.lastIndexOf(':');
  if (portAt === -1) return encodeUriPart(host, 'authority');
  return encodeUriPart(host.slice(0, portAt), 'authority') + host.slice(portAt);
}

/** `<user>:<password>@<host>:<port>`: the host is lower-cased and the port is written as it is. */
function formatAuthority(authority: string): string {
  const at = authority.indexOf('@');
  const host = formatHost(authority.slice(at + 1).toLowerCase());
  return at === -1 ? host : `${formatUserinfo(authority.slice(0, at))}@${host}`;
}

/** `/C:/x` and `C:/x` are written with a lower-case drive letter. */
function lowerCaseDriveLetter(path: string): string {
  return path.replace(
    /^(\/?)([A-Z]):/,
    (_match, slash: string, drive: string) => `${slash}${drive.toLowerCase()}:`,
  );
}

export class Uri {
  readonly scheme = 'file';

  private constructor(
    readonly authority: string,
    readonly path: string,
  ) {}

  /**
   * Like vscode-uri on macOS and Linux: a leading `//host/` is a UNC authority, on every platform,
   * and a path that still starts with `//` once there is no authority (`////srv/x`) is refused
   * with a `[UriError]`, the one rule of `_validateUri` that a `file:` URI can break.
   */
  static file(fsPath: string): Uri {
    if (fsPath.startsWith('//')) {
      const slash = fsPath.indexOf('/', 2);
      const end = slash === -1 ? fsPath.length : slash;
      return Uri.validated(new Uri(fsPath.slice(2, end), fsPath.slice(end) || '/'));
    }
    return Uri.validated(new Uri('', fsPath.startsWith('/') ? fsPath : `/${fsPath}`));
  }

  private static validated(uri: Uri): Uri {
    if (uri.authority === '' && uri.path.startsWith('//')) {
      throw new Error(
        '[UriError]: If a URI does not contain an authority component, ' +
          'then the path cannot begin with two slash characters ("//")',
      );
    }
    return uri;
  }

  /** Throws a URIError for an unpaired surrogate, as vscode-uri does. */
  toString(): string {
    const path = encodeUriPart(lowerCaseDriveLetter(this.path), 'path');
    return `${this.scheme}://${formatAuthority(this.authority)}${path}`;
  }
}

export class DocumentLink {
  tooltip?: string;

  constructor(
    readonly range: Range,
    readonly target?: Uri,
  ) {}
}

export function withVscodeExtras<T extends object>(actual: T): T & Record<string, unknown> {
  return { ...actual, Position, Range, MarkdownString, Hover, Uri, DocumentLink };
}

/** The values of one setting at the scopes a test cares about (VS Code's `inspect()` result). */
export interface SettingScopes {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

/**
 * What `workspace.getConfiguration(section)` returns for a setting that is set at the given scopes:
 * `get` answers with the effective value (the narrowest scope wins), `inspect` with each scope.
 */
export function configurationWith(scopes: SettingScopes) {
  const effective = scopes.workspaceFolderValue ?? scopes.workspaceValue ?? scopes.globalValue;
  return {
    get: (_key: string, fallback?: unknown) => effective ?? fallback,
    inspect: (key: string) => ({ key: `commandvault.${key}`, ...scopes }),
    update: async () => undefined,
  };
}

/** A one-line text document, enough for the providers that scan `lineAt`. */
export function documentOf(lines: readonly string[]) {
  return {
    lineCount: lines.length,
    lineAt: (lineOrPosition: number | Position) => ({
      text: lines[typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line] ?? '',
    }),
  };
}
