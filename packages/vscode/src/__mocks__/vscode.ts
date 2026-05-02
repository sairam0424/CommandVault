import { vi } from 'vitest';

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  iconPath?: ThemeIcon;
  description?: string;
  tooltip?: MarkdownString | string;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    label: string,
    collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  };

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
}

export class MarkdownString {
  value = '';

  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export class Uri {
  readonly fsPath: string;
  readonly scheme: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  static file(path: string): Uri {
    return new Uri('file', path);
  }
}

export enum ViewColumn {
  One = 1,
  Two = 2,
  Three = 3,
}

export const window = {
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  showQuickPick: vi.fn().mockResolvedValue(undefined),
  showInputBox: vi.fn().mockResolvedValue(undefined),
  showSaveDialog: vi.fn().mockResolvedValue(undefined),
  showOpenDialog: vi.fn().mockResolvedValue(undefined),
  showTextDocument: vi.fn().mockResolvedValue(undefined),
  createQuickPick: vi.fn().mockReturnValue({
    placeholder: '',
    matchOnDescription: false,
    matchOnDetail: false,
    items: [] as unknown[],
    selectedItems: [] as unknown[],
    onDidChangeValue: vi.fn(),
    onDidAccept: vi.fn(),
    onDidHide: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
  createWebviewPanel: vi.fn().mockReturnValue({
    webview: {
      html: '',
      onDidReceiveMessage: vi.fn(),
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    iconPath: undefined,
    dispose: vi.fn(),
  }),
  activeTerminal: undefined as unknown,
  createTerminal: vi.fn().mockReturnValue({
    show: vi.fn(),
    sendText: vi.fn(),
  }),
};

export const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  }),
  openTextDocument: vi.fn().mockResolvedValue({ uri: Uri.file('/mock/file.ts') }),
  fs: {
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
};

export const commands = {
  registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  executeCommand: vi.fn().mockResolvedValue(undefined),
};

export const env = {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
};
