import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ora defaults to discardStdin: true, and its stop() pauses process.stdin, which Ink never resumes
 * (the TUI then ignores every key, Ctrl+C included). ui/spinner.ts is the one module allowed to
 * import ora because it is the one that passes discardStdin: false.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPINNER_MODULE = join(SRC_DIR, 'ui', 'spinner.ts');
const INTERACTIVE_MODULE = join(SRC_DIR, 'commands', 'interactive.tsx');
const SOURCE_FILE = /\.(ts|tsx)$/;
const FORBIDDEN_MODULE = 'ora';

function listSourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) return dirent.name === '__tests__' ? [] : listSourceFiles(path);
    return SOURCE_FILE.test(dirent.name) ? [path] : [];
  });
}

function isOraSpecifier(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === FORBIDDEN_MODULE;
}

function isOraLoad(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  return (isRequire || isDynamicImport) && isOraSpecifier(node.arguments[0]);
}

function isOraStatement(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return isOraSpecifier(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return isOraSpecifier(node.moduleReference.expression);
  }
  return isOraLoad(node);
}

function findOraLoads(file: string): readonly string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isOraStatement(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${relative(SRC_DIR, file).split(sep).join('/')}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('ora import guard', () => {
  it('scans the real source tree, including the spinner module', () => {
    const files = listSourceFiles(SRC_DIR);
    expect(files).toContain(SPINNER_MODULE);
    expect(files).toContain(INTERACTIVE_MODULE);
  });

  it('allows only ui/spinner.ts to load ora', () => {
    const offenders = listSourceFiles(SRC_DIR)
      .filter((file) => file !== SPINNER_MODULE)
      .flatMap(findOraLoads);
    expect(offenders).toEqual([]);
  });

  it('spinner.ts itself does load ora (the guard sees real imports)', () => {
    expect(findOraLoads(SPINNER_MODULE).length).toBeGreaterThan(0);
  });
});
