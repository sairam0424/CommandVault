import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeDir, resolveDataDir } from '../packages/core/src/paths.js';

/**
 * Detects a test run that touched the REAL CommandVault data directory or the REAL Claude
 * configuration directory. The hermetic setup points HOME at a temp dir inside every worker, so a
 * change here means something reached the real locations by another route (an absolute path, a
 * child process started without HOME, a module that cached the home directory).
 *
 * The real locations are read in the vitest MAIN process, before any override:
 *   - the data directory: every entry with its size and mtime,
 *   - the Claude directory: only the names and mtimes of its top-level entries. It is NOT walked:
 *     a real one holds tens of thousands of transcript files.
 *
 * Caveat: a live Claude Code session writes to its own directory while tests run, which can trip
 * the Claude check (for example `history.jsonl`). The failure message names every changed entry.
 */

type EnvLike = Readonly<Record<string, string | undefined>>;

interface EntryStat {
  /** -1 when the size is deliberately not compared. */
  readonly size: number;
  readonly mtimeMs: number;
}

type DirState = 'missing' | 'unreadable' | 'present';

interface DirSnapshot {
  readonly path: string;
  readonly state: DirState;
  readonly entries: Readonly<Record<string, EntryStat>>;
}

const NOT_COMPARED = -1;
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
}

function statEntry(path: string, compareSize: boolean): EntryStat | null {
  try {
    const stat = lstatSync(path);
    return { size: compareSize ? stat.size : NOT_COMPARED, mtimeMs: stat.mtimeMs };
  } catch (error) {
    // An entry removed between readdir and lstat is a race with another process, not a change we
    // can attribute; anything else (permissions) is recorded as a failure by the caller.
    if (MISSING_CODES.has(errorCode(error))) return null;
    throw error;
  }
}

/** Lists the direct children of `path`; never descends. */
function snapshotDir(path: string, compareSize: boolean): DirSnapshot {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    const state: DirState = MISSING_CODES.has(errorCode(error)) ? 'missing' : 'unreadable';
    return { path, state, entries: {} };
  }

  const entries = Object.fromEntries(
    [...names].sort().flatMap((name) => {
      const stat = statEntry(join(path, name), compareSize);
      return stat ? [[name, stat] as const] : [];
    }),
  );
  return { path, state: 'present', entries };
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

interface RealLocations {
  readonly dataDirs: readonly string[];
  readonly claudeDirs: readonly string[];
}

/**
 * The default locations under the launching HOME, plus wherever the launching env redirects them.
 * Both come from the production resolvers, so a `~/x` or relative COMMANDVAULT_HOME is watched at
 * the directory the CLI would really use; an empty env yields the default twice, which `unique` folds.
 */
function realLocations(env: EnvLike = process.env): RealLocations {
  return {
    dataDirs: unique([resolveDataDir({}), resolveDataDir(env)]),
    claudeDirs: unique([resolveClaudeDir({}), resolveClaudeDir(env)]),
  };
}

export interface RealHomeSnapshot {
  readonly dataDirs: readonly DirSnapshot[];
  readonly claudeDirs: readonly DirSnapshot[];
}

export function snapshotRealHome(env: EnvLike = process.env): RealHomeSnapshot {
  const { dataDirs, claudeDirs } = realLocations(env);
  return {
    dataDirs: dataDirs.map((path) => snapshotDir(path, true)),
    claudeDirs: claudeDirs.map((path) => snapshotDir(path, false)),
  };
}

/** Every directory the snapshot covers, data directories first. */
export function watchedPaths(snapshot: RealHomeSnapshot): string[] {
  return [...snapshot.dataDirs, ...snapshot.claudeDirs].map((dir) => dir.path);
}

function describeEntryChanges(before: DirSnapshot, after: DirSnapshot): string[] {
  const changes: string[] = [];
  const names = unique([...Object.keys(before.entries), ...Object.keys(after.entries)]).sort();
  for (const name of names) {
    const was = before.entries[name];
    const now = after.entries[name];
    const where = join(after.path, name);
    if (!was && now) changes.push(`added ${where}`);
    else if (was && !now) changes.push(`removed ${where}`);
    else if (was && now && (was.size !== now.size || was.mtimeMs !== now.mtimeMs)) {
      changes.push(
        `modified ${where} (size ${was.size} -> ${now.size}, mtime ${was.mtimeMs} -> ${now.mtimeMs})`,
      );
    }
  }
  return changes;
}

function describeDirChanges(before: DirSnapshot, after: DirSnapshot): string[] {
  if (before.state !== after.state) {
    return [`${after.path} went from ${before.state} to ${after.state}`];
  }
  return describeEntryChanges(before, after);
}

function diffDirs(before: readonly DirSnapshot[], after: readonly DirSnapshot[]): string[] {
  return before.flatMap((snapshot, index) => {
    const later = after[index];
    return later ? describeDirChanges(snapshot, later) : [];
  });
}

/** One line per change between two snapshots of the same locations; empty when nothing changed. */
export function diffRealHome(before: RealHomeSnapshot, after: RealHomeSnapshot): string[] {
  return [
    ...diffDirs(before.dataDirs, after.dataDirs),
    ...diffDirs(before.claudeDirs, after.claudeDirs),
  ];
}

export function formatSentinelFailure(changes: readonly string[]): string {
  return [
    'The test run changed the REAL CommandVault data directory or the REAL Claude directory:',
    ...changes.map((change) => `  - ${change}`),
    'Tests must build their fixtures in the temp HOME that test-support/hermetic-home.ts creates.',
    'If only Claude Code files such as history.jsonl changed, a live session wrote them: re-run.',
  ].join('\n');
}
