import { dirname, join, relative, sep } from 'node:path';
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
const SAFE_TEXT_MODULE = join(SRC_DIR, 'ui', 'safe-text.ts');

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
  const rel = relative(SRC_DIR, file).split(sep).join('/');
  return (
    rel.startsWith('commands/') ||
    rel.startsWith('tui/') ||
    rel === 'helpers.ts' ||
    rel.startsWith('__tests__/fixtures/safe-text-guard/')
  );
}

/** JSON.stringify outside a sanitising call is checked where console is the sink. */
function printsJson(file: string): boolean {
  const rel = relative(SRC_DIR, file).split(sep).join('/');
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
    return `${relative(SRC_DIR, source.fileName).split(sep).join('/')}:${line + 1}`;
  }

  private isAllowlisted(source: ts.SourceFile, node: ts.Node): boolean {
    const lines = source.text.split('\n');
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const own = lines[line] ?? '';
    const previous = lines[line - 1] ?? '';
    return (
      ALLOW_COMMENT.test(own) || (ALLOW_COMMENT.test(previous) && previous.trim().startsWith('//'))
    );
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
    scanned = program.getRootFileNames().filter((file) => file !== SAFE_TEXT_MODULE);
  }, PROGRAM_TIMEOUT_MS);

  it('scans the real tree: commands, the TUI, helpers and the fixtures, not the primitive', () => {
    expect(scanned).toContain(join(SRC_DIR, 'commands', 'list.ts'));
    expect(scanned).toContain(join(SRC_DIR, 'commands', 'interactive.tsx'));
    expect(scanned).toContain(join(SRC_DIR, 'tui', 'App.tsx'));
    expect(scanned).toContain(join(SRC_DIR, 'helpers.ts'));
    expect(scanned).toContain(OFFENDER_FIXTURE);
    expect(scanned).toContain(CLEAN_FIXTURE);
    expect(scanned).not.toContain(SAFE_TEXT_MODULE);
    expect(
      scanned.some(
        (file) => file.includes(`${sep}__tests__${sep}`) && !file.startsWith(FIXTURE_DIR),
      ),
    ).toBe(false);
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

  it('finds no uncleared read of a tainted field anywhere in the shipped tree', () => {
    const offenders = scanned
      .filter((file) => !file.startsWith(FIXTURE_DIR))
      .flatMap((file) => guard.offendersIn(file));
    expect(offenders).toEqual([]);
  });

  it('allowlists exactly the recorded non-display reads, nothing more', () => {
    const allowlisted = scanned
      .filter((file) => !file.startsWith(FIXTURE_DIR))
      .flatMap((file) => guard.allowlistedIn(file))
      .sort();
    expect(allowlisted).toEqual(EXPECTED_ALLOWLIST);
  });
});
