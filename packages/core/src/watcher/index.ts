import { watch, type FSWatcher } from 'chokidar';
import { createSourceIgnore, watchedDirectories, watchedFiles } from './source-filter.js';

export type WatcherCallback = (event: 'add' | 'change' | 'unlink', path: string) => void;

// With followSymlinks on, a symlink cycle (ELOOP) or an unreadable directory
// (EACCES) surfaces as an 'error' event. An EventEmitter without a listener for
// it throws, which would take down the host process, so it is reported here as
// a warning and the rest of the tree keeps being watched.
function reportWatcherError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[commandvault] file watcher error (watching continues): ${detail}`);
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly claudePath: string;

  constructor(claudePath: string) {
    this.claudePath = claudePath;
  }

  start(callback: WatcherCallback): void {
    if (this.watcher) return;

    const watchPaths = [...watchedDirectories(this.claudePath), ...watchedFiles(this.claudePath)];

    this.watcher = watch(watchPaths, {
      ignoreInitial: true,
      // Skill folders are commonly symlinks into a shared skills repo.
      followSymlinks: true,
      ignored: createSourceIgnore(this.claudePath),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher
      .on('add', (path) => callback('add', path))
      .on('change', (path) => callback('change', path))
      .on('unlink', (path) => callback('unlink', path))
      .on('error', reportWatcherError);
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
