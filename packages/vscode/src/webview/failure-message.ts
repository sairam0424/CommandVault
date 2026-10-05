/** Node error codes (`ENOENT`, `ERR_FS_...`): short, upper case, and nothing a renderer reads as markup. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** The error's `code` when it is a plain identifier of that shape, else undefined. */
function safeErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/**
 * The text for a notification that reports a failed action.
 *
 * VS Code turns `[label](command:...)` in a notification into a button that runs the command, and
 * an error message from the file system carries the path, which a third party chose. So the
 * message is never used: the notification names the action and, when there is one, the error code.
 */
export function failureMessage(action: string, err: unknown): string {
  const code = safeErrorCode(err);
  return code === undefined ? `CommandVault: ${action}` : `CommandVault: ${action} (${code})`;
}
