import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { KEYS, TEST_TIMEOUT_MS, makeEntry, makeVault, mountApp } from './harness.js';

const SETTLE_MS = 400;
const TYPED_CHARS = 'abcdefgh';

const NAMES = ['alpha', 'beta', 'gamma'];
const filteringVault = () => {
  const entries = NAMES.map((name) => makeEntry(name));
  return makeVault(entries, ({ query }) => entries.filter((e) => e.name.includes(query)));
};
const settle = () => new Promise((done) => setTimeout(done, SETTLE_MS));

describe('App keys that follow a query edit in the same read', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
  });

  it('stops Down at the last row of the list the typed text narrowed to', async () => {
    const vault = filteringVault();
    const { write } = await mountApp(vault);

    // "al" finds only alpha, so Down has nowhere to go and Ctrl+F favorites alpha.
    await write(`al${KEYS.down}${KEYS.ctrlF}`);

    await vi.waitFor(() => expect(vault.toggleFavorite).toHaveBeenCalledTimes(1));
    expect(vault.toggleFavorite).toHaveBeenCalledWith('alpha');
  });

  it('lets Down move through the list the deleted text widened back to', async () => {
    const vault = filteringVault();
    const { write } = await mountApp(vault);
    await write('al');
    await settle();

    // The two backspaces bring all three entries back, so Down reaches beta.
    await write(`${KEYS.backspace}${KEYS.backspace}${KEYS.down}${KEYS.ctrlF}`);

    await vi.waitFor(() => expect(vault.toggleFavorite).toHaveBeenCalledTimes(1));
    expect(vault.toggleFavorite).toHaveBeenCalledWith('beta');
  });
});

describe('App search while typing', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
  });

  it('searches once for text typed without a pause, not once per key', async () => {
    const vault = filteringVault();
    const { write } = await mountApp(vault);

    for (const char of TYPED_CHARS) await write(char);
    await settle();

    const searched = vi.mocked(vault.search).mock.calls.map(([options]) => options.query);
    expect(searched).toEqual([TYPED_CHARS]);
  });
});
