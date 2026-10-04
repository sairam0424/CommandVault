import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_EDITOR = 'vi';

/** Opens a file in $EDITOR and blocks until the editor exits. Throws if it cannot start. */
export function openInEditor(filePath: string): void {
  const editor = process.env['EDITOR'] ?? DEFAULT_EDITOR;
  execFileSync(editor, [resolve(filePath)], { stdio: 'ignore' });
}
