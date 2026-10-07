import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { KEYS, TEST_TIMEOUT_MS, makeEntry, makeVault, mountApp } from './harness.js';

const clipboardWrite = vi.hoisted(() => vi.fn());
vi.mock('clipboardy', () => ({ default: { write: clipboardWrite } }));

const LOCKED = 'database is locked';

function mountOne() {
  const vault = makeVault([makeEntry('alpha')]);
  return { vault, mounted: mountApp(vault) };
}

describe('App when the vault throws', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
    clipboardWrite.mockReset();
    clipboardWrite.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('survives toggleFavorite throwing: names the failure, stays mounted and keeps typing', async () => {
    const { vault, mounted } = mountOne();
    vi.mocked(vault.toggleFavorite).mockImplementation(() => {
      throw new Error(LOCKED);
    });
    const { frame, write, waitForFrame } = await mounted;

    await expect(write(KEYS.ctrlF)).resolves.toBeUndefined();

    await waitForFrame((f) => f.includes(`Could not save the favorite: ${LOCKED}`));
    expect(frame()).not.toContain('Added to favorites');

    await write('abc');
    await waitForFrame((f) => f.includes('> abc'));
  });

  it('reports a copied command whose usage could not be recorded, not a clipboard error', async () => {
    const { vault, mounted } = mountOne();
    vi.mocked(vault.recordUsage).mockImplementation(() => {
      throw new Error(LOCKED);
    });
    const { frame, write, waitForFrame } = await mounted;

    await write(KEYS.enter);

    await waitForFrame((f) => f.includes(`Copied: /alpha (usage not saved: ${LOCKED})`));
    expect(clipboardWrite).toHaveBeenCalledWith('/alpha');
    expect(frame()).not.toContain('Clipboard error');
  });

  it('keeps the clipboard label for a clipboard failure and records no usage', async () => {
    const { vault, mounted } = mountOne();
    clipboardWrite.mockRejectedValue(new Error('no clipboard tool found'));
    const { write, waitForFrame } = await mounted;

    await write(KEYS.enter);

    await waitForFrame((f) => f.includes('Clipboard error: no clipboard tool found'));
    expect(vault.recordUsage).not.toHaveBeenCalled();
  });

  it('survives getSlashCommand throwing on Enter and copies nothing', async () => {
    const { vault, mounted } = mountOne();
    vi.mocked(vault.getSlashCommand).mockImplementation(() => {
      throw new Error('no command for this entry');
    });
    const { write, waitForFrame } = await mounted;

    await expect(write(KEYS.enter)).resolves.toBeUndefined();

    await waitForFrame((f) => f.includes('Could not copy the command: no command for this entry'));
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(vault.recordUsage).not.toHaveBeenCalled();
  });
});
