import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  relativePosixPath,
  scanNotifications,
  type NotificationScan,
} from './helpers/unsafe-notifications';

/**
 * Every toast goes through the notifications module, and the text it is given is fixed or made safe.
 * This is what keeps the next `showInformationMessage(\`... ${entry.name}\`)` from reintroducing a
 * link that runs a command: it fails the build. A scan that cannot fail is worth nothing, so the
 * second half of this file runs the same scan on small programs that are wrong in each way.
 */

const SRC_DIR = join(__dirname, '..');
const PACKAGE_DIR = join(SRC_DIR, '..');
const NOTIFICATIONS_MODULE = join(SRC_DIR, 'webview', 'notifications.ts');
const SCAN_TIMEOUT_MS = 90_000;
const MIN_TOAST_CALL_SITES = 15;
const RAW_FUNCTION_COUNT = 3;

function listSourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      const isTestCode = dirent.name === '__tests__' || dirent.name === '__mocks__';
      return isTestCode ? [] : listSourceFiles(path);
    }
    return dirent.name.endsWith('.ts') ? [path] : [];
  });
}

function packageCompilerOptions(): ts.CompilerOptions {
  const configPath = join(PACKAGE_DIR, 'tsconfig.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, PACKAGE_DIR);
  return { ...parsed.options, noEmit: true, incremental: false, composite: false };
}

describe('notification guard: the real source', () => {
  const files = listSourceFiles(SRC_DIR);
  let scan: NotificationScan;

  beforeAll(() => {
    scan = scanNotifications(files, NOTIFICATIONS_MODULE, SRC_DIR, packageCompilerOptions());
  }, SCAN_TIMEOUT_MS);

  it('scans the modules that show toasts, including the one that calls VS Code', () => {
    const names = files.map((file) => relativePosixPath(SRC_DIR, file));

    expect(names).toEqual(
      expect.arrayContaining([
        'extension.ts',
        'commands/index.ts',
        'webview/detail-panel.ts',
        'webview/notifications.ts',
      ]),
    );
  });

  it('names a file the same way on every platform, with / between the parts', () => {
    const windowsRoot = 'C:\\repo\\packages\\vscode\\src';

    expect(relativePosixPath(windowsRoot, `${windowsRoot}\\commands\\index.ts`, path.win32)).toBe(
      'commands/index.ts',
    );
    expect(
      relativePosixPath(windowsRoot, 'C:/repo/packages/vscode/src/webview/x.ts', path.win32),
    ).toBe('webview/x.ts');
    expect(relativePosixPath('/repo/src', '/repo/src/commands/index.ts', path.posix)).toBe(
      'commands/index.ts',
    );
    expect(relativePosixPath(SRC_DIR, join(SRC_DIR, 'commands', 'index.ts'))).toBe(
      'commands/index.ts',
    );
  });

  it('sees the toast call sites and the raw VS Code calls it is there to confine', () => {
    expect(scan.checkedCalls.length).toBeGreaterThanOrEqual(MIN_TOAST_CALL_SITES);
    expect(scan.exemptRawMentions).toBeGreaterThanOrEqual(RAW_FUNCTION_COUNT);
  });

  it('finds no raw show*Message call, and no toast with text it cannot vouch for', () => {
    expect(scan.findings).toEqual([]);
  });
});

const NOTIFICATIONS_STUB = [
  'export declare function notifyInfo(message: string, ...items: string[]): void;',
  'export declare function notifyWarn(message: string, ...items: string[]): void;',
  'export declare function notifyError(message: string, ...items: string[]): void;',
  'export declare function safeNotificationText(text: string): string;',
  'export declare function failureMessage(action: string, err: unknown): string;',
  'export declare const window: Record<string, (message: string) => void>;',
  'export const raw = (message: string): void => window.showErrorMessage(message);',
].join('\n');

const FIXTURE_IMPORTS =
  "import { notifyInfo, notifyWarn, notifyError, safeNotificationText, failureMessage, window } from './notifications';";

const WRONG: readonly (readonly [string, string])[] = [
  ['a template with a string', 'export const f = (name: string) => notifyInfo(`hi ${name}`);'],
  ['a string variable', 'export const f = (name: string) => notifyWarn(name);'],
  ['a concatenation', "export const f = (name: string) => notifyError('hi ' + name);"],
  ['a property of an object', 'export const f = (e: { name: string }) => notifyInfo(`${e.name}`);'],
  ['text in a button label', "export const f = (name: string) => notifyInfo('hi', name);"],
  ['a value of unknown type', 'export const f = (x: unknown) => notifyInfo(`${x}`);'],
  ['a value of any type', 'export const f = (x: any) => notifyInfo(`${x}`);'],
  ['a template type over string', 'export const f = (n: `x${string}`) => notifyInfo(`${n}`);'],
  [
    'a call that only looks safe',
    'declare function safeText(text: string): string;\n' +
      'export const f = (name: string) => notifyInfo(`${safeText(name)}`);',
  ],
  [
    'a string nested in a safe-looking template',
    'export const f = (name: string) =>\n' +
      '  notifyInfo(`a ${safeNotificationText(name)} ${`b ${name}`}`);',
  ],
  [
    'a conditional that returns the string',
    "export const f = (name: string, ok: boolean) => notifyInfo(ok ? 'ok' : name);",
  ],
  [
    'a let that was made safe and then reassigned',
    'export const f = (name: string) => {\n  let text = safeNotificationText(name);\n  text = name;\n  return notifyInfo(text);\n};',
  ],
  [
    'a const copy of a string',
    'export const f = (name: string) => {\n  const text = name;\n  return notifyInfo(text);\n};',
  ],
  [
    'a const built from a string',
    'export const f = (name: string) => {\n  const text = `x ${name}`;\n  return notifyInfo(text);\n};',
  ],
  [
    'a const taken out of an object',
    'export const f = (e: { name: string }) => {\n  const { name } = e;\n  return notifyInfo(name);\n};',
  ],
  ['a cast to a literal type', "export const f = (name: string) => notifyInfo(name as 'ok');"],
  [
    'a cast to a union of literal types',
    "export const f = (name: string) => notifyInfo(name as 'a' | 'b');",
  ],
  [
    'an angle-bracket assertion to a literal type',
    "export const f = (name: string) => notifyInfo(<'ok'>name);",
  ],
  [
    'a cast through unknown to a literal type',
    "export const f = (name: string) => notifyInfo(name as unknown as 'ok');",
  ],
  [
    'a cast to a literal type inside a template',
    "export const f = (name: string) => notifyInfo(`hi ${name as 'ok'}`);",
  ],
  [
    'a const cast to a literal type',
    "export const f = (name: string) => {\n  const text = name as 'ok';\n  return notifyInfo(text);\n};",
  ],
  [
    'a const asserted to a literal type',
    "export const f = (name: string) => {\n  const text = <'ok'>name;\n  return notifyInfo(text);\n};",
  ],
  [
    'a notify function imported under another name',
    "import { notifyInfo as show } from './notifications';\nexport const f = (name: string) => show(name);",
  ],
  [
    'a notify function kept in a variable',
    'const show = notifyInfo;\nexport const f = (name: string) => show(name);',
  ],
  [
    'a notify function passed as a value',
    'export const f = (names: string[]) => names.map((n) => n).forEach(notifyWarn);',
  ],
  [
    'a notify function called through a namespace import',
    "import * as n from './notifications';\nexport const f = (name: string) => n.notifyError(name);",
  ],
  [
    'a notify function called by element access',
    "import * as n from './notifications';\nexport const f = (name: string) => n['notifyInfo'](name);",
  ],
  [
    'a raw function imported under another name',
    "import { showErrorMessage as fail } from './notifications';\nexport const f = () => fail('x');",
  ],
  ['a raw call', "export const f = () => window.showInformationMessage('fixed text');"],
  ['a raw call by element access', "export const f = () => window['showWarningMessage']('x');"],
  ['a raw function taken off the object', 'export const { showErrorMessage } = window;'],
];

const RIGHT: readonly (readonly [string, string])[] = [
  ['a literal', "export const f = () => notifyInfo('CommandVault: hi');"],
  ['a template with no substitution', 'export const f = () => notifyInfo(`CommandVault: hi`);'],
  ['a number', 'export const f = (n: number) => notifyInfo(`CommandVault: ${n} entries`);'],
  ['a boolean', 'export const f = (b: boolean) => notifyInfo(`CommandVault: ${b}`);'],
  [
    'a property that is a number',
    'export const f = (s: { total: number }) => notifyInfo(`${s.total} entries`);',
  ],
  [
    'a constant string',
    "const MESSAGE = 'CommandVault: hi';\nexport const f = () => notifyWarn(MESSAGE);",
  ],
  [
    'a conditional of literals',
    "export const f = (ok: boolean) => notifyInfo(`x ${ok ? 'added to' : 'removed from'} y`);",
  ],
  [
    'a value typed as a union of literals',
    "export const f = (kind: 'a' | 'b') => notifyInfo(`x ${kind}`);",
  ],
  [
    'text made safe',
    'export const f = (name: string) => notifyInfo(`"${safeNotificationText(name)}" added`);',
  ],
  [
    'a failure message',
    "export const f = (e: unknown) => notifyError(failureMessage('Could not open file', e));",
  ],
  [
    'a concatenation of fixed and safe text',
    "export const f = (n: string) => notifyInfo('hi ' + safeNotificationText(n));",
  ],
  [
    'a const made safe',
    'export const f = (name: string) => {\n  const text = safeNotificationText(name);\n  return notifyInfo(`"${text}" added`);\n};',
  ],
  [
    'a conditional of safe text',
    "export const f = (name: string) =>\n  notifyInfo(`x${name ? ` (${safeNotificationText(name)})` : ''}`);",
  ],
  ['a button label', "export const f = () => notifyInfo('hi', 'Show Details');"],
  ['a literal cast to const', "export const f = () => notifyInfo('hi' as const);"],
  ['a literal asserted to its own type', "export const f = () => notifyInfo(<'hi'>'hi');"],
  [
    'safe text called through a namespace import',
    "import * as n from './notifications';\nexport const f = (name: string) => n.notifyInfo(n.safeNotificationText(name));",
  ],
  [
    'a const typed as a union of literals',
    "export const f = (kind: 'a' | 'b') => {\n  const label = kind;\n  return notifyInfo(label);\n};",
  ],
];

describe('notification guard: programs that are wrong, and programs that are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'notification-guard-'));
  const notificationsModule = join(root, 'notifications.ts');
  const fileFor = (group: string, index: number): string => join(root, `${group}-${index}.ts`);
  let scan: NotificationScan;

  beforeAll(() => {
    writeFileSync(notificationsModule, NOTIFICATIONS_STUB);
    const groups = [
      ['wrong', WRONG],
      ['right', RIGHT],
    ] as const;
    const fixtures = groups.flatMap(([group, cases]) =>
      cases.map(([, body], index) => {
        writeFileSync(fileFor(group, index), `${FIXTURE_IMPORTS}\n${body}\n`);
        return fileFor(group, index);
      }),
    );
    scan = scanNotifications([notificationsModule, ...fixtures], notificationsModule, root, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      lib: ['lib.es2022.d.ts'],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    });
  }, SCAN_TIMEOUT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const findingsIn = (file: string) =>
    scan.findings.filter((finding) => finding.where.startsWith(file.slice(root.length + 1)));

  it.each(WRONG.map(([name], index) => [name, index] as const))('reports %s', (_name, index) => {
    expect(findingsIn(fileFor('wrong', index))).not.toEqual([]);
  });

  it.each(RIGHT.map(([name], index) => [name, index] as const))('accepts %s', (_name, index) => {
    const file = fileFor('right', index);

    expect(findingsIn(file)).toEqual([]);
    expect(scan.checkedCalls.some((where) => where.startsWith(file.slice(root.length + 1)))).toBe(
      true,
    );
  });

  it('counts the raw calls in the module that is exempt', () => {
    expect(scan.exemptRawMentions).toBeGreaterThan(0);
  });
});
