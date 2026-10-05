import * as path from 'path';
import * as vscode from 'vscode';

/** Every error vscode-uri throws about the shape of a URI starts with this (`_validateUri`). */
const VSCODE_URI_ERROR_PREFIX = '[UriError]';

/**
 * True for the two ways a path can be impossible to express as a URI: `Uri.file` refuses one that
 * still starts with `//` once it has no authority (`////srv/x`), and `Uri.toString` throws a
 * URIError on an unpaired UTF-16 surrogate, which NTFS allows in a file name. Both are rare, but
 * one such entry must not take the provider down. Matched by name and message, not class, so it
 * holds across realms; nothing else is swallowed.
 */
function isUnrepresentableAsUri(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'URIError' || err.message.startsWith(VSCODE_URI_ERROR_PREFIX))
  );
}

/**
 * The URI of the local file an entry was read from, or undefined when there is nothing to open:
 * imported and synced entries have a label like `imported:/tmp/bundle.json` instead of a path,
 * a UNC path (`//host/share/...`) would make the editor contact another machine, and a path that
 * cannot be written as a URI would make the provider throw for the whole document.
 */
export function sourceFileUri(filePath: string): vscode.Uri | undefined {
  if (!path.isAbsolute(filePath)) {
    return undefined;
  }
  try {
    const uri = vscode.Uri.file(filePath);
    // The editor serialises the link with toString() later, where a throw would be far from here.
    uri.toString();
    return uri.authority === '' ? uri : undefined;
  } catch (err) {
    if (isUnrepresentableAsUri(err)) {
      return undefined;
    }
    throw err;
  }
}
