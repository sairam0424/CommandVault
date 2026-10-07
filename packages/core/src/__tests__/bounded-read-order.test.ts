import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `readBoundedText` opens the file once and does everything else on that handle: the type and
 * size checks run on `handle.stat()`, the read is bounded by counting bytes, and the handle is
 * closed on every path. These tests wrap the handle `open` returns so each step is observable,
 * and they can make `stat` lie about the size to show that the count, not the stat, is the bound.
 */

interface HandleSpy {
  readonly stat: Mock;
  readonly read: Mock;
  readonly close: Mock;
}

const spy = vi.hoisted(() => ({
  handles: [] as HandleSpy[],
  statSize: null as number | null,
  statError: null as Error | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const real = await actual.open(...args);
    const read = real.read.bind(real) as (...readArgs: unknown[]) => Promise<unknown>;
    const handle: HandleSpy = {
      stat: vi.fn(async () => {
        if (spy.statError !== null) throw spy.statError;
        const stats = await real.stat();
        if (spy.statSize === null) return stats;
        // Same prototype, so isFile() and friends still work on the forged size.
        return Object.assign(Object.create(Object.getPrototypeOf(stats) as object), stats, {
          size: spy.statSize,
        });
      }),
      read: vi.fn((...readArgs: unknown[]) => read(...readArgs)),
      close: vi.fn(() => real.close()),
    };
    spy.handles.push(handle);
    return handle as unknown as FileHandle;
  });
  return { ...actual, open };
});

import { open } from 'node:fs/promises';
import {
  FileTooLargeError,
  NotRegularFileError,
  readBoundedText,
} from '../parsers/bounded-read.js';

const SMALL_FILE_BUFFER_BYTES = 4 * 1024;

let tempDir: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cv-bounded-order-')));
  spy.handles.length = 0;
  spy.statSize = null;
  spy.statError = null;
  vi.mocked(open).mockClear();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function onlyHandle(): HandleSpy {
  expect(spy.handles).toHaveLength(1);
  return spy.handles[0];
}

describe('readBoundedText checks on the open handle before it reads', () => {
  it('never reads a file whose stat size is over the limit, and closes the handle once', async () => {
    const filePath = join(tempDir, 'over.md');
    await writeFile(filePath, '123456');

    await expect(readBoundedText(filePath, 5)).rejects.toBeInstanceOf(FileTooLargeError);

    const handle = onlyHandle();
    expect(handle.stat).toHaveBeenCalledTimes(1);
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('reads a file at the limit through the handle and closes it exactly once', async () => {
    const filePath = join(tempDir, 'edge.md');
    await writeFile(filePath, '12345');

    await expect(readBoundedText(filePath, 5)).resolves.toBe('12345');

    // One open, one handle: the data in a single read, the read that finds the end of the file,
    // and nothing asked for past the limit plus the one byte that would prove the file too big.
    const handle = onlyHandle();
    expect(open).toHaveBeenCalledTimes(1);
    const reads = handle.read.mock.calls as [Buffer, number, number][];
    expect(reads).toHaveLength(2);
    for (const [, offset, length] of reads) expect(offset + length).toBeLessThanOrEqual(5 + 1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('bounds the read by counting bytes: a file that grew past the stat size is refused', async () => {
    const filePath = join(tempDir, 'grew.md');
    await writeFile(filePath, '123456');
    spy.statSize = 5;

    const failure = await readBoundedText(filePath, 5).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(FileTooLargeError);
    expect((failure as FileTooLargeError).sizeBytes).toBe(6);
    expect((failure as FileTooLargeError).limitBytes).toBe(5);
    const handle = onlyHandle();
    expect(handle.read).toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('decodes what it counted: a file the stat under-reports but that fits is read whole', async () => {
    const filePath = join(tempDir, 'under.md');
    await writeFile(filePath, '12345');
    spy.statSize = 2;

    await expect(readBoundedText(filePath, 5)).resolves.toBe('12345');

    expect(onlyHandle().close).toHaveBeenCalledTimes(1);
  });

  it('sizes its one buffer from the stat: a small file is read with two small reads', async () => {
    const filePath = join(tempDir, 'small.md');
    await writeFile(filePath, '12345');

    await expect(readBoundedText(filePath)).resolves.toBe('12345');

    // The data, then the read that finds the end of the file; neither needs a 64 KiB buffer.
    const reads = onlyHandle().read.mock.calls as [Buffer, number, number][];
    expect(reads).toHaveLength(2);
    for (const [buffer] of reads) expect(buffer.length).toBeLessThan(SMALL_FILE_BUFFER_BYTES);
    expect(reads[0][0]).toBe(reads[1][0]);
  });

  it('grows the buffer when the stat under-reports, and decodes characters that straddle it', async () => {
    const filePath = join(tempDir, 'grows.md');
    const text = `${'あ'.repeat(40_000)}\nend`;
    await writeFile(filePath, text);
    spy.statSize = 1;

    await expect(readBoundedText(filePath, 1_000_000)).resolves.toBe(text);

    expect(onlyHandle().close).toHaveBeenCalledTimes(1);
  });

  it('never asks for more than one byte past the limit, however far the stat is off', async () => {
    const filePath = join(tempDir, 'bounded.md');
    await writeFile(filePath, 'x'.repeat(300));
    spy.statSize = 1;

    await expect(readBoundedText(filePath, 100)).rejects.toBeInstanceOf(FileTooLargeError);

    const reads = onlyHandle().read.mock.calls as [Buffer, number, number][];
    for (const [buffer] of reads) expect(buffer.length).toBeLessThanOrEqual(101);
  });

  it('closes the handle when stat itself fails', async () => {
    const filePath = join(tempDir, 'stat-fails.md');
    await writeFile(filePath, 'x');
    spy.statError = Object.assign(new Error('simulated EIO'), { code: 'EIO' });

    await expect(readBoundedText(filePath)).rejects.toMatchObject({ code: 'EIO' });

    expect(onlyHandle().close).toHaveBeenCalledTimes(1);
  });

  it('closes the handle when the file is not a regular file', async () => {
    const dirPath = join(tempDir, 'folder.md');
    await mkdir(dirPath);

    await expect(readBoundedText(dirPath)).rejects.toBeInstanceOf(NotRegularFileError);

    const handle = onlyHandle();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
