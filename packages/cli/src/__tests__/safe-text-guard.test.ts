import path, { dirname, join, type PlatformPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Entry fields reach the terminal from third-party files, bundles and registries, and a terminal
 * obeys any escape sequence it is handed. This guard type-checks the CLI and fails on every read
 * of a text-bearing field of a tainted record (VaultEntry, SearchResult, RegistryEntry,
 * ExportedEntry, ParseError), and on every getSlashCommand/getTagsForEntry result, that does not
 * sit inside an argument of one of the sanitising calls. It is a whole-file rule, not a
 * console.log-argument rule: info.ts prints a prebuilt array, interactive.tsx hands labels to
 * inquirer and tag.ts prints a loop variable, none of which a sink rule would see.
 *
 * Escape hatch: a `// safe-text: <reason>` comment on the line or the line above clears that
 * line; the exact allowlist is asserted below and must hold only non-display uses.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSCONFIG = join(SRC_DIR, '..', 'tsconfig.json');
const FIXTURE_DIR = join(SRC_DIR, '__tests__', 'fixtures', 'safe-text-guard');
const OFFENDER_FIXTURE = join(FIXTURE_DIR, 'offender.ts');
const CLEAN_FIXTURE = join(FIXTURE_DIR, 'clean.ts');
/** src-relative, forward-slash forms: the only form any path below is compared in. */
const FIXTURE_REL = '__tests__/fixtures/safe-text-guard/';
const OFFENDER_REL = `${FIXTURE_REL}offender.ts`;
const CLEAN_REL = `${FIXTURE_REL}clean.ts`;
const SAFE_TEXT_REL = 'ui/safe-text.ts';

/**
 * `file` relative to `root`, forward slashes, whatever form either came in. TypeScript reports
 * forward-slash absolute paths even on Windows (`D:/a/.../src/commands/list.ts`) while `join`
 * builds backslash ones there (`D:\a\...\src`), and the drive letter may differ in case;
 * `relative` resolves all three, so no comparison in this file is made on absolute strings.
 */
function srcRelative(file: string, root = SRC_DIR, p: PlatformPath = path): string {
  return p.relative(root, file).split(p.sep).join('/');
}

function isFixture(file: string): boolean {
  return srcRelative(file).startsWith(FIXTURE_REL);
}

/**
 * The read's own line, or a comment-only line above it, carries `// safe-text: <reason>`.
 * Line text comes from the source file's own line map, the one `locate` and `isAllowlisted`
 * number reads with, so the lookup cannot disagree with TypeScript about where a line starts:
 * a CRLF checkout, a lone CR or a U+2028 all count as one break on both sides.
 */
function hasAllowComment(source: ts.SourceFile, line: number): boolean {
  const own = lineText(source, line);
  const previous = lineText(source, line - 1);
  return (
    ALLOW_COMMENT.test(own) || (ALLOW_COMMENT.test(previous) && previous.trim().startsWith('//'))
  );
}

/** Text of `line` (0-based) including its terminator; '' outside the file. */
function lineText(source: ts.SourceFile, line: number): string {
  const starts = source.getLineStarts();
  if (line < 0 || line >= starts.length) return '';
  return source.text.slice(starts[line], starts[line + 1] ?? source.text.length);
}

const TAINTED_TYPES: ReadonlySet<string> = new Set([
  'VaultEntry',
  'SearchResult',
  'RegistryEntry',
  'ExportedEntry',
  'ParseError',
]);
const TAINTED_CALLS: ReadonlySet<string> = new Set(['getSlashCommand', 'getTagsForEntry']);
/**
 * Calls whose arguments are sanitised. A call is matched by its callee identifier or, for a
 * method call, by the method name AND the object identifier: `chalk.red(x)` is named both `red`
 * and `chalk`, so listing either here would (wrongly) clear it.
 */
const CLEARED_CALLS: ReadonlySet<string> = new Set([
  'safeText',
  'toDisplay',
  'jsonOutput',
  'singleLine',
  'printable',
  'previewContent',
]);
/** Generic wrappers that keep the taint of their argument. */
const TRANSPARENT_ALIASES: ReadonlySet<string> = new Set([
  'Readonly',
  'Partial',
  'Required',
  'NonNullable',
]);
/** The sanitised view: reads on it are not reads on a core record. */
const DISPLAY_ALIAS = 'Display';
const UNTAINTED_PROPERTY = 'id';
const ALLOW_COMMENT = /\/\/\s*safe-text:\s*\S/;

/**
 * Reads in the shipped tree a `// safe-text:` comment clears, sorted as strings. Every one is a
 * non-display use: a path that is resolved, opened or stat-ed; content used for a line index or a
 * count; a membership test; the clipboard payload (the status line goes through singleLine); the
 * JSON printer's own JSON.stringify; and config.json written to disk.
 */
const EXPECTED_ALLOWLIST: readonly string[] = [
  'commands/doctor.ts:220',
  'commands/doctor.ts:251',
  'commands/init.ts:100',
  'commands/interactive.tsx:104',
  'commands/list.ts:81',
  'commands/open.ts:28',
  'helpers.ts:85',
  'tui/App.tsx:107',
  'tui/App.tsx:110',
  'tui/App.tsx:160',
  'tui/App.tsx:180',
  'tui/App.tsx:83',
  'tui/PreviewPane.tsx:76',
];

/** Files whose reads are checked: commands, the TUI, helpers and the two fixtures. */
function isScanned(file: string): boolean {
  const rel = srcRelative(file);
  return (
    rel.startsWith('commands/') ||
    rel.startsWith('tui/') ||
    rel === 'helpers.ts' ||
    rel.startsWith(FIXTURE_REL)
  );
}

/** JSON.stringify outside a sanitising call is checked where console is the sink. */
function printsJson(file: string): boolean {
  const rel = srcRelative(file);
  return rel.startsWith('commands/') || rel === 'helpers.ts';
}

function buildProgram(): ts.Program {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG, {}, host);
  if (!parsed) throw new Error(`could not parse ${TSCONFIG}`);
  const rootNames = parsed.fileNames.filter(isScanned);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
  return ts.createProgram({ rootNames, options });
}

class Guard {
  private readonly checker: ts.TypeChecker;

  constructor(private readonly program: ts.Program) {
    this.checker = program.getTypeChecker();
  }

  /** `path:line` of every uncleared tainted read in `file`, allowlisted lines excluded. */
  offendersIn(file: string): readonly string[] {
    return this.readsIn(file)
      .filter(({ source, node }) => !this.isAllowlisted(source, node))
      .map(({ source, node }) => this.locate(source, node));
  }

  /** `path:line` of every read a `// safe-text:` comment cleared in `file`. */
  allowlistedIn(file: string): readonly string[] {
    return this.readsIn(file)
      .filter(({ source, node }) => this.isAllowlisted(source, node))
      .map(({ source, node }) => this.locate(source, node));
  }

  private readsIn(file: string): readonly { source: ts.SourceFile; node: ts.Node }[] {
    const source = this.program.getSourceFile(file);
    if (!source) throw new Error(`${file} is not in the program`);
    const hits: { source: ts.SourceFile; node: ts.Node }[] = [];
    const visit = (node: ts.Node): void => {
      if (this.isTaintedRead(node, source) && !this.isCleared(node)) hits.push({ source, node });
      ts.forEachChild(node, visit);
    };
    visit(source);
    return hits;
  }

  private locate(source: ts.SourceFile, node: ts.Node): string {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${srcRelative(source.fileName)}:${line + 1}`;
  }

  private isAllowlisted(source: ts.SourceFile, node: ts.Node): boolean {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return hasAllowComment(source, line);
  }

  private isTaintedRead(node: ts.Node, source: ts.SourceFile): boolean {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return this.isTaintedAccess(node);
    }
    if (ts.isBindingElement(node)) return this.isTaintedBinding(node);
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee !== undefined && TAINTED_CALLS.has(callee)) return true;
      return callee === 'stringify' && isJsonObject(node) && printsJson(source.fileName);
    }
    return false;
  }

  /** `entry.name`, `entry['name']`: the object is tainted and the field carries text. */
  private isTaintedAccess(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
    const property = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    if (property === UNTAINTED_PROPERTY) return false;
    if (!this.isTainted(this.checker.getTypeAtLocation(node.expression))) return false;
    return this.carriesText(this.checker.getTypeAtLocation(node));
  }

  /** `const { name } = entry`, `({ filePath, message }) => ...`: the same read, spelled as a pattern. */
  private isTaintedBinding(node: ts.BindingElement): boolean {
    const pattern = node.parent;
    if (!ts.isObjectBindingPattern(pattern)) return false;
    const property = node.propertyName ?? node.name;
    if (!ts.isIdentifier(property) || property.text === UNTAINTED_PROPERTY) return false;
    if (!this.isTainted(this.checker.getTypeAtLocation(pattern))) return false;
    return this.carriesText(this.checker.getTypeAtLocation(node));
  }

  private isTainted(type: ts.Type): boolean {
    const t = this.checker.getNonNullableType(type);
    if (t.aliasSymbol?.name === DISPLAY_ALIAS) return false;
    if (TAINTED_TYPES.has(t.aliasSymbol?.name ?? '') || TAINTED_TYPES.has(t.symbol?.name ?? '')) {
      return true;
    }
    if (t.aliasSymbol && TRANSPARENT_ALIASES.has(t.aliasSymbol.name)) {
      return (t.aliasTypeArguments ?? []).some((arg) => this.isTainted(arg));
    }
    if (t.isUnionOrIntersection()) return t.types.some((part) => this.isTainted(part));
    return false;
  }

  /** `string` (not a union of literals), an array of such, or a record such as `metadata`. */
  private carriesText(type: ts.Type): boolean {
    const t = this.checker.getNonNullableType(type);
    if (t.isUnion()) return t.types.some((part) => this.carriesText(part));
    if (t.flags & ts.TypeFlags.String) return true;
    if (this.checker.isArrayLikeType(t)) {
      const element = this.checker.getIndexTypeOfType(t, ts.IndexKind.Number);
      return element === undefined || this.carriesText(element);
    }
    if (t.flags & ts.TypeFlags.Object) {
      // A nested tainted record is checked through its own reads; a Date carries no text.
      return !this.isTainted(t) && t.symbol?.name !== 'Date';
    }
    return false;
  }

  /** The read sits inside an argument of a sanitising call. */
  private isCleared(node: ts.Node): boolean {
    let child: ts.Node = node;
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === child)) {
        if (calleeNames(parent).some((name) => CLEARED_CALLS.has(name))) return true;
      }
      child = parent;
      parent = parent.parent;
    }
    return false;
  }
}

/** `f(x)` -> `f`; `obj.method(x)` -> `method` (the name a tainted or cleared call is listed under). */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** `calleeName` plus, for `obj.method(x)` with a plain identifier object, `obj` as well. */
function calleeNames(call: ts.CallExpression): readonly string[] {
  const name = calleeName(call);
  const names = name === undefined ? [] : [name];
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return [...names, callee.expression.text];
  }
  return names;
}

function isJsonObject(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON'
  );
}

/** Building a program over the CLI and its types takes seconds; on a loaded machine, many. */
const PROGRAM_TIMEOUT_MS = 180_000;

describe('safe-text guard', () => {
  let program: ts.Program;
  let guard: Guard;
  let scanned: readonly string[];

  beforeAll(() => {
    program = buildProgram();
    guard = new Guard(program);
    scanned = program.getRootFileNames().filter((file) => srcRelative(file) !== SAFE_TEXT_REL);
  }, PROGRAM_TIMEOUT_MS);

  it('scans the real tree: commands, the TUI, helpers and the fixtures, not the primitive', () => {
    // TypeScript reports its own path form (forward slashes on every OS); compare src-relative.
    const rels = scanned.map((file) => srcRelative(file));
    expect(rels).toContain('commands/list.ts');
    expect(rels).toContain('commands/interactive.tsx');
    expect(rels).toContain('tui/App.tsx');
    expect(rels).toContain('helpers.ts');
    expect(rels).toContain(OFFENDER_REL);
    expect(rels).toContain(CLEAN_REL);
    expect(rels).not.toContain(SAFE_TEXT_REL);
    expect(rels.some((rel) => rel.includes('__tests__/') && !rel.startsWith(FIXTURE_REL))).toBe(
      false,
    );
  });

  it('sees exactly the three reads in the offender fixture (core types resolve, not any)', () => {
    expect(guard.offendersIn(OFFENDER_FIXTURE)).toEqual([
      `__tests__/fixtures/safe-text-guard/offender.ts:9`,
      `__tests__/fixtures/safe-text-guard/offender.ts:10`,
      `__tests__/fixtures/safe-text-guard/offender.ts:11`,
    ]);
  });

  it('sees nothing in the clean fixture', () => {
    expect(guard.offendersIn(CLEAN_FIXTURE)).toEqual([]);
  });

  // The two tree-wide walks type-check every scanned file; on a loaded machine they pass 5 s.
  it(
    'finds no uncleared read of a tainted field anywhere in the shipped tree',
    () => {
      const offenders = scanned
        .filter((file) => !isFixture(file))
        .flatMap((file) => guard.offendersIn(file));
      expect(offenders).toEqual([]);
    },
    PROGRAM_TIMEOUT_MS,
  );

  it(
    'allowlists exactly the recorded non-display reads, nothing more',
    () => {
      const allowlisted = scanned
        .filter((file) => !isFixture(file))
        .flatMap((file) => guard.allowlistedIn(file))
        .sort();
      expect(allowlisted).toEqual(EXPECTED_ALLOWLIST);
    },
    PROGRAM_TIMEOUT_MS,
  );
});

/**
 * The Windows runner failed the two tree checks above at 8487896: `scanned` held TypeScript's
 * `D:/a/.../src/commands/list.ts` while `join` built `D:\a\...\src\commands\list.ts`, so
 * `toContain` missed and `startsWith(FIXTURE_DIR)` let the offender fixture leak into the
 * shipped-tree scan (its three reads were the three "offenders"). Nobody can run Windows here;
 * `path.win32` exercises the same resolution.
 */
describe('safe-text guard: one path form on every OS', () => {
  const WIN_ROOT = 'D:\\a\\CommandVault\\CommandVault\\packages\\cli\\src';
  const TS_LIST = 'D:/a/CommandVault/CommandVault/packages/cli/src/commands/list.ts';
  const TS_OFFENDER = `D:/a/CommandVault/CommandVault/packages/cli/src/${OFFENDER_REL}`;

  it("maps TypeScript's forward-slash absolute paths onto a backslash root", () => {
    expect(srcRelative(TS_LIST, WIN_ROOT, path.win32)).toBe('commands/list.ts');
    expect(srcRelative(TS_OFFENDER, WIN_ROOT, path.win32)).toBe(OFFENDER_REL);
    expect(srcRelative(TS_OFFENDER, WIN_ROOT, path.win32).startsWith(FIXTURE_REL)).toBe(true);
  });

  it('gives the same form for the path join builds on Windows', () => {
    const joined = path.win32.join(WIN_ROOT, 'commands', 'list.ts');
    expect(joined).not.toBe(TS_LIST);
    expect(srcRelative(joined, WIN_ROOT, path.win32)).toBe(
      srcRelative(TS_LIST, WIN_ROOT, path.win32),
    );
  });

  it('ignores drive-letter and directory case on Windows', () => {
    const lower = 'd:/a/commandvault/commandvault/packages/cli/src/helpers.ts';
    expect(srcRelative(lower, WIN_ROOT, path.win32)).toBe('helpers.ts');
  });

  it('is a plain relative path on POSIX', () => {
    expect(srcRelative('/w/packages/cli/src/tui/App.tsx', '/w/packages/cli/src', path.posix)).toBe(
      'tui/App.tsx',
    );
  });

  /**
   * The only way a checkout's line breaks could break the escape hatch is the comment lookup
   * numbering lines differently from TypeScript, which reports the read's line. A trailing `\r`
   * is invisible to the comment regex and to trim(), so CRLF alone never showed it; a lone CR or a
   * U+2028 (one break to TypeScript, none to a split on `\n`) does.
   */
  it('finds the escape-hatch comment on the line TypeScript numbers, for every line break', () => {
    const lines = [
      'const a = entry.name;',
      '// safe-text: resolved, not printed',
      'const b = entry.filePath;',
      'const c = entry.name; // safe-text: counted',
      'const d = entry.name;',
    ];
    for (const lineBreak of ['\n', '\r\n', '\r', '\u2028']) {
      const text = lines.join(lineBreak) + lineBreak;
      const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.ES2022, true);
      const lineOf = (snippet: string): number =>
        source.getLineAndCharacterOfPosition(text.indexOf(snippet)).line;
      expect(lineOf('const d')).toBe(4);
      expect(hasAllowComment(source, lineOf('const a'))).toBe(false);
      expect(hasAllowComment(source, lineOf('const b'))).toBe(true);
      expect(hasAllowComment(source, lineOf('const c'))).toBe(true);
      expect(hasAllowComment(source, lineOf('const d'))).toBe(false);
    }
  });
});
