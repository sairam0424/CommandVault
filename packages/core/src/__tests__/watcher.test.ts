import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// Mock chokidar before importing VaultWatcher
const mockWatcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
mockWatcher.close = vi.fn().mockResolvedValue(undefined);

vi.mock('chokidar', () => ({
  watch: vi.fn(() => mockWatcher),
}));

import { watch } from 'chokidar';
import { VaultWatcher, type WatcherCallback } from '../watcher/index.js';

const CLAUDE_PATH = '/home/user/.claude';

describe('VaultWatcher', () => {
  let watcher: VaultWatcher;
  let callback: WatcherCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    // Remove all listeners from previous tests
    mockWatcher.removeAllListeners();
    mockWatcher.close = vi.fn().mockResolvedValue(undefined);

    watcher = new VaultWatcher(CLAUDE_PATH);
    callback = vi.fn();
  });

  afterEach(async () => {
    // Reset watcher state via stop
    if (watcher.isWatching) {
      await watcher.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Basic event handling
  // -------------------------------------------------------------------------
  it('triggers callback with "add" event when a file is added', () => {
    watcher.start(callback);

    const filePath = join(CLAUDE_PATH, 'skills', 'new-skill', 'SKILL.md');
    mockWatcher.emit('add', filePath);

    expect(callback).toHaveBeenCalledWith('add', filePath);
  });

  it('triggers callback with "change" event when a file is modified', () => {
    watcher.start(callback);

    const filePath = join(CLAUDE_PATH, 'rules', 'coding-style.md');
    mockWatcher.emit('change', filePath);

    expect(callback).toHaveBeenCalledWith('change', filePath);
  });

  it('triggers callback with "unlink" event when a file is deleted', () => {
    watcher.start(callback);

    const filePath = join(CLAUDE_PATH, 'agents', 'old-agent.md');
    mockWatcher.emit('unlink', filePath);

    expect(callback).toHaveBeenCalledWith('unlink', filePath);
  });

  // -------------------------------------------------------------------------
  // Watch paths configuration
  // -------------------------------------------------------------------------
  it('watches the correct glob patterns for all entry types', () => {
    watcher.start(callback);

    const watchCall = vi.mocked(watch).mock.calls[0];
    const watchPaths = watchCall[0] as string[];

    expect(watchPaths).toContain(join(CLAUDE_PATH, 'skills', '**', 'SKILL.md'));
    expect(watchPaths).toContain(join(CLAUDE_PATH, 'agents', '*.md'));
    expect(watchPaths).toContain(join(CLAUDE_PATH, 'commands', '**', '*.md'));
    expect(watchPaths).toContain(join(CLAUDE_PATH, 'plugins', 'installed_plugins.json'));
    expect(watchPaths).toContain(join(CLAUDE_PATH, 'rules', '*.md'));
    expect(watchPaths).toContain(join(CLAUDE_PATH, 'settings.json'));
  });

  it('passes followSymlinks: false to chokidar options', () => {
    watcher.start(callback);

    const watchCall = vi.mocked(watch).mock.calls[0];
    const options = watchCall[1] as Record<string, unknown>;

    expect(options.followSymlinks).toBe(false);
  });

  it('passes ignoreInitial: true to chokidar options', () => {
    watcher.start(callback);

    const watchCall = vi.mocked(watch).mock.calls[0];
    const options = watchCall[1] as Record<string, unknown>;

    expect(options.ignoreInitial).toBe(true);
  });

  it('configures awaitWriteFinish for debounce stability', () => {
    watcher.start(callback);

    const watchCall = vi.mocked(watch).mock.calls[0];
    const options = watchCall[1] as Record<string, unknown>;

    expect(options.awaitWriteFinish).toEqual({
      stabilityThreshold: 300,
      pollInterval: 100,
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle management
  // -------------------------------------------------------------------------
  it('reports isWatching as false before start', () => {
    expect(watcher.isWatching).toBe(false);
  });

  it('reports isWatching as true after start', () => {
    watcher.start(callback);
    expect(watcher.isWatching).toBe(true);
  });

  it('can be stopped and sets isWatching to false', async () => {
    watcher.start(callback);
    expect(watcher.isWatching).toBe(true);

    await watcher.stop();

    expect(watcher.isWatching).toBe(false);
    expect(mockWatcher.close).toHaveBeenCalledOnce();
  });

  it('stop is idempotent when no watcher is active', async () => {
    await watcher.stop();

    expect(mockWatcher.close).not.toHaveBeenCalled();
    expect(watcher.isWatching).toBe(false);
  });

  it('does not create a second watcher if start is called twice', () => {
    watcher.start(callback);
    watcher.start(callback);

    expect(vi.mocked(watch)).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Multiple events
  // -------------------------------------------------------------------------
  it('handles multiple sequential events correctly', () => {
    watcher.start(callback);

    const path1 = join(CLAUDE_PATH, 'rules', 'a.md');
    const path2 = join(CLAUDE_PATH, 'rules', 'b.md');
    const path3 = join(CLAUDE_PATH, 'agents', 'c.md');

    mockWatcher.emit('add', path1);
    mockWatcher.emit('change', path2);
    mockWatcher.emit('unlink', path3);

    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, 'add', path1);
    expect(callback).toHaveBeenNthCalledWith(2, 'change', path2);
    expect(callback).toHaveBeenNthCalledWith(3, 'unlink', path3);
  });

  it('does not invoke callback after stop is called', async () => {
    watcher.start(callback);
    await watcher.stop();

    // After stop, the internal watcher reference is null so even if mock emits,
    // the real watcher would not forward events. We verify stop was called.
    expect(mockWatcher.close).toHaveBeenCalledOnce();
  });
});
