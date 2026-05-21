import { watch, type FSWatcher } from 'chokidar';
import { join } from 'node:path';

export type WatcherCallback = (event: 'add' | 'change' | 'unlink', path: string) => void;

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly claudePath: string;

  constructor(claudePath: string) {
    this.claudePath = claudePath;
  }

  start(callback: WatcherCallback): void {
    if (this.watcher) return;

    const watchPaths = [
      join(this.claudePath, 'skills', '**', 'SKILL.md'),
      join(this.claudePath, 'agents', '*.md'),
      join(this.claudePath, 'commands', '**', '*.md'),
      join(this.claudePath, 'plugins', 'installed_plugins.json'),
      join(this.claudePath, 'rules', '*.md'),
      join(this.claudePath, 'settings.json'),
    ];

    this.watcher = watch(watchPaths, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher
      .on('add', (path) => callback('add', path))
      .on('change', (path) => callback('change', path))
      .on('unlink', (path) => callback('unlink', path));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  get isWatching(): boolean {
    return this.watcher !== null;
  }
}
