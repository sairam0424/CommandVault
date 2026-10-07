import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommands } from '../parsers/command-parser.js';
import { getParseSeverity } from '../scan-pipeline.js';

/**
 * The commands walk used to let one unreadable subdirectory reject the whole walk, which the
 * caller reported as "Commands directory not found" with zero command entries. Only the top
 * directory failing may mean that; a subdirectory failing costs its own files and one warning.
 * Root reads anything, so the permission cases are skipped under uid 0.
 */

const IS_WINDOWS = process.platform === 'win32';
const IS_ROOT = process.getuid?.() === 0;
const NO_ACCESS = 0o000;
const FULL_ACCESS = 0o700;

let tempDir: string;
let commandsDir: string;
let lockedDir: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-walkdir-')));
  commandsDir = join(tempDir, 'commands');
  lockedDir = join(commandsDir, 'locked');
  await mkdir(lockedDir, { recursive: true });
  await writeFile(join(commandsDir, 'ok.md'), '---\ndescription: ok\n---\nBody\n');
  await writeFile(join(lockedDir, 'hidden.md'), '---\ndescription: hidden\n---\nBody\n');
});

afterEach(async () => {
  // rm needs to list a directory before it can remove it.
  await chmod(lockedDir, FULL_ACCESS).catch(() => undefined);
  await chmod(commandsDir, FULL_ACCESS).catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS || IS_ROOT)('walkDir and an unreadable subdirectory', () => {
  it('keeps the siblings and warns once when one subdirectory cannot be read', async () => {
    await chmod(lockedDir, NO_ACCESS);

    const result = await parseCommands(commandsDir);

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].filePath).toBe(lockedDir);
    expect(result.errors[0].message).toContain(`Skipped unreadable directory ${lockedDir}`);
    expect(getParseSeverity(result.errors[0])).toBe('warning');
  });

  it('still reports an unreadable top directory as not found', async () => {
    await chmod(commandsDir, NO_ACCESS);

    const result = await parseCommands(commandsDir);

    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([
      { filePath: commandsDir, message: 'Commands directory not found', severity: 'error' },
    ]);
  });
});

describe('walkDir and a missing top directory', () => {
  it('reports a missing top directory as not found, as before', async () => {
    const missing = join(tempDir, 'missing');

    const result = await parseCommands(missing);

    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([
      { filePath: missing, message: 'Commands directory not found', severity: 'error' },
    ]);
  });
});
