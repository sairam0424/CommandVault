import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Wrap the real readFile so the suite can observe whether a path was ever read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { readFile } from 'node:fs/promises';
import { FileTooLargeError, readBoundedText } from '../parsers/bounded-read.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-bounded-order-')));
  vi.mocked(readFile).mockClear();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('readBoundedText checks the size before it reads', () => {
  it('never calls readFile for a file over the limit', async () => {
    const filePath = join(tempDir, 'over.md');
    await writeFile(filePath, '123456');

    await expect(readBoundedText(filePath, 5)).rejects.toBeInstanceOf(FileTooLargeError);

    expect(readFile).not.toHaveBeenCalled();
  });

  it('calls readFile exactly once for a file at the limit', async () => {
    const filePath = join(tempDir, 'edge.md');
    await writeFile(filePath, '12345');

    await expect(readBoundedText(filePath, 5)).resolves.toBe('12345');

    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
