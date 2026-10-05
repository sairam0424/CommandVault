import { vi } from 'vitest';
import { window } from 'vscode';

/**
 * What VS Code 1.138 turns into a clickable link in a notification. Copied verbatim from
 * out/vs/workbench/workbench.desktop.main.js (`n9n`, used by parseLinkedText). The notification
 * renderer opens the href with `openerService.open(uri, { allowCommands: true })`, so a
 * `[label](command:...)` anywhere in a message is a button that runs any command.
 */
const NOTIFICATION_LINK =
  /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

export interface NotificationLink {
  readonly label: string;
  readonly href: string;
}

/** The links VS Code would draw in `message`. */
export function linksIn(message: string): readonly NotificationLink[] {
  return [...message.matchAll(NOTIFICATION_LINK)].map((match) => ({
    label: match[1],
    href: match[2],
  }));
}

const NOTIFICATION_FUNCTIONS = [
  window.showInformationMessage,
  window.showWarningMessage,
  window.showErrorMessage,
] as const;

/** Every message the code under test has passed to a show*Message call since the mocks were last cleared. */
export function shownNotifications(): readonly string[] {
  return NOTIFICATION_FUNCTIONS.flatMap((fn) =>
    (fn as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0])),
  );
}

/** Links in all shown notifications, so a test fails on any sink and not only the one it had in mind. */
export function linksInShownNotifications(): readonly NotificationLink[] {
  return shownNotifications().flatMap(linksIn);
}
