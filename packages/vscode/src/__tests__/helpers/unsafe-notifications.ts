import path, { resolve } from 'node:path';
import ts from 'typescript';

/**
 * A notification is a sink: VS Code draws `[label](command:...)` in it as a button that runs the
 * command. This finds the code that could put text a third party chose into one.
 *
 * The rule has two halves. Nothing outside the notifications module may call `show*Message`, so
 * every toast goes through `notifyInfo`, `notifyWarn` or `notifyError`. And the text given to those
 * must be fixed: a literal, a number or boolean, a value whose type is a union of literals, or a
 * `safeNotificationText(...)` / `failureMessage(...)` call. A `string` from anywhere else is text
 * somebody may have chosen, so it is a finding. The types are the declared ones, except that a cast
 * (`x as 'ok'`, `<'ok'>x`) is seen through, in an argument and in the `const` an argument names.
 *
 * What the scan cannot see: callees are matched by name, so a function that merely is called
 * `safeNotificationText` is believed, and a name built at run time (`window['show' + 'ErrorMessage']`)
 * or taken from a value typed `any` is not found. Both take a deliberate act, and neither can draw
 * a link all the same: the notify wrappers split every `](` of the finished message. This scan is
 * for the accident, so its findings are what a reviewer reads.
 */

const RAW_NOTIFICATION_FUNCTIONS: ReadonlySet<string> = new Set([
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage',
]);
const NOTIFY_FUNCTIONS: ReadonlySet<string> = new Set(['notifyInfo', 'notifyWarn', 'notifyError']);
const TRUSTED_TEXT_FUNCTIONS: ReadonlySet<string> = new Set([
  'safeNotificationText',
  'failureMessage',
]);

const FIXED_VALUE_FLAGS =
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined;

export interface NotificationFinding {
  readonly where: string;
  readonly reason: string;
}

export interface NotificationScan {
  readonly findings: readonly NotificationFinding[];
  /** Where each call to notifyInfo/notifyWarn/notifyError that was checked is (none means the scan saw nothing). */
  readonly checkedCalls: readonly string[];
  /** Mentions of show*Message in the exempt module (zero means the scan cannot see raw calls). */
  readonly exemptRawMentions: number;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return undefined;
}

function isFixedType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(isFixedType);
  return (type.flags & FIXED_VALUE_FLAGS) !== 0;
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
}

function isTrustedCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const name = calleeName(expression);
  return name !== undefined && TRUSTED_TEXT_FUNCTIONS.has(name);
}

/** The initializer of a `const` the identifier names, when it has one. */
function constantInitializer(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.VariableDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
  const isConst = (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  return isConst && declaration.initializer !== undefined ? declaration : undefined;
}

/**
 * Whether `expression` can only ever be text this program wrote or text already made safe. A `const`
 * is followed to what it was set to; a `let` or a parameter is not, because it can hold anything,
 * and a `const` of another module is believed by its type.
 */
function isFixedText(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  followed: ReadonlySet<ts.Node> = new Set(),
): boolean {
  const inner = unwrap(expression);
  const isFixed = (part: ts.Expression): boolean => isFixedText(part, checker, followed);
  if (isTrustedCall(inner)) return true;
  if (ts.isTemplateExpression(inner))
    return inner.templateSpans.every((s) => isFixed(s.expression));
  if (ts.isConditionalExpression(inner)) return isFixed(inner.whenTrue) && isFixed(inner.whenFalse);
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isFixed(inner.left) && isFixed(inner.right);
  }
  const declaration = ts.isIdentifier(inner) ? constantInitializer(inner, checker) : undefined;
  if (declaration?.initializer !== undefined) {
    // A const is what it was set to, whatever type it was given: `const text = name as 'ok'` is `name`.
    const seen = new Set([...followed, declaration]);
    return !followed.has(declaration) && isFixedText(declaration.initializer, checker, seen);
  }
  return isFixedType(checker.getTypeAtLocation(inner));
}

/**
 * `file` relative to `root`, always with `/` between the parts: a path joined on Windows has `\\`
 * in it and a TypeScript file name has `/`, and tests compare both with names written with `/`.
 */
export function relativePosixPath(root: string, file: string, flavor: typeof path = path): string {
  return flavor.relative(root, file).split(flavor.sep).join('/');
}

function describeLocation(node: ts.Node, source: ts.SourceFile, root: string): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relativePosixPath(root, source.fileName)}:${line + 1}`;
}

/**
 * Whether `node` (an identifier spelled like a notify function) is what a call calls or an import of
 * it under its own name. Anywhere else (`const show = notifyInfo`, `names.map(notifyWarn)`,
 * `import { notifyInfo as show }`) its argument is not where this scan looks.
 */
function isCalledOrImportedByName(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isImportSpecifier(parent)) return parent.propertyName === undefined;
  if (ts.isCallExpression(parent)) return parent.expression === node;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  );
}

function isRawNotificationName(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return RAW_NOTIFICATION_FUNCTIONS.has(node.text);
  return ts.isStringLiteralLike(node) && RAW_NOTIFICATION_FUNCTIONS.has(node.text);
}

/**
 * Checks `files` (absolute paths) for notifications that could carry text a third party chose.
 * `exemptFile` is the one module allowed to call `show*Message`; `root` only shortens the report.
 */
export function scanNotifications(
  files: readonly string[],
  exemptFile: string,
  root: string,
  options: ts.CompilerOptions,
): NotificationScan {
  const wanted = new Set(files.map((file) => resolve(file)));
  const program = ts.createProgram({ rootNames: [...wanted], options });
  const checker = program.getTypeChecker();
  const findings: NotificationFinding[] = [];
  const checkedCalls: string[] = [];
  let exemptRawMentions = 0;

  for (const source of program.getSourceFiles()) {
    if (!wanted.has(resolve(source.fileName))) continue;
    const isExempt = resolve(source.fileName) === resolve(exemptFile);

    const visit = (node: ts.Node): void => {
      if (isRawNotificationName(node)) {
        if (isExempt) {
          exemptRawMentions += 1;
        } else {
          const reason = `${(node as ts.Identifier).text} is used outside the notifications module`;
          findings.push({ where: describeLocation(node, source, root), reason });
        }
      }
      if (
        !isExempt &&
        ts.isIdentifier(node) &&
        NOTIFY_FUNCTIONS.has(node.text) &&
        !isCalledOrImportedByName(node)
      ) {
        const reason = `${node.text} is used as a value or under another name`;
        findings.push({ where: describeLocation(node, source, root), reason });
      }
      if (ts.isCallExpression(node) && NOTIFY_FUNCTIONS.has(calleeName(node) ?? '')) {
        checkedCalls.push(describeLocation(node, source, root));
        for (const argument of node.arguments) {
          if (!isFixedText(argument, checker)) {
            const reason = `${calleeName(node)} is given text that is not fixed: ${argument.getText(source)}`;
            findings.push({ where: describeLocation(argument, source, root), reason });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { findings, checkedCalls, exemptRawMentions };
}
