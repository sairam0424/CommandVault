import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The webview app has a project of its own (webview/tsconfig.json: target ES2020, DOM, JSX) that
 * `pnpm typecheck` does not run, since that runs the extension's tsconfig over src/ and leaves
 * webview/ out. Nothing else checks it before the build, so a call to an API newer than its library
 * (`Object.hasOwn` is ES2022) got as far as review. This checks the project as its own tsconfig
 * declares it.
 */

const WEBVIEW_DIR = join(__dirname, '..', '..', 'webview');
const TYPECHECK_TIMEOUT_MS = 120_000;

function diagnosticsOfWebviewProject(): readonly string[] {
  const { config } = ts.readConfigFile(join(WEBVIEW_DIR, 'tsconfig.json'), ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, WEBVIEW_DIR);
  const program = ts.createProgram({ rootNames: fileNames, options: { ...options, noEmit: true } });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const where = diagnostic.file?.fileName ?? 'the project';
    return `${where.slice(WEBVIEW_DIR.length)}: TS${diagnostic.code} ${text}`;
  });
}

describe('the webview project', () => {
  it(
    'type-checks against the library its own tsconfig declares',
    () => {
      expect(diagnosticsOfWebviewProject()).toEqual([]);
    },
    TYPECHECK_TIMEOUT_MS,
  );
});
