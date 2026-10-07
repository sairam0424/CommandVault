import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistryManager } from '../registry/index.js';
import { safeFetchText, SafeFetchError } from '../net/safe-fetch.js';

/**
 * A registry that fails must be reported, never folded into an empty page: `vault registry search`
 * used to print "No results" and exit 0 while every registry was down (RC-CLI-02).
 */

vi.mock('../net/safe-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../net/safe-fetch.js')>()),
  safeFetchText: vi.fn(),
}));

const fetcher = vi.mocked(safeFetchText);

const GOOD_URL = 'https://good.example/registry.json';
const DOWN_URL = 'https://down.example/registry.json';
const BAD_URL = 'https://bad.example/registry.json';

const ENTRIES = [
  { name: 'alpha-tool', description: 'alpha things', type: 'skill', url: 'https://x/alpha' },
  { name: 'beta-tool', description: 'beta things', type: 'agent', url: 'https://x/beta' },
];

function serveByUrl(): void {
  fetcher.mockImplementation(async (url) => {
    switch (url) {
      case GOOD_URL:
        return { status: 200, text: JSON.stringify(ENTRIES) };
      case BAD_URL:
        return { status: 200, text: '{"entries": "not an array"}' };
      default:
        throw new SafeFetchError('headers_timeout', 'no response headers within 15 s');
    }
  });
}

function manager(...urls: readonly string[]): RegistryManager {
  const built = new RegistryManager({ allowPrivateHosts: ['good.example'] });
  urls.forEach((url, index) => built.addRegistry({ name: `r${index}`, url, type: 'json' }));
  return built;
}

describe('RegistryManager.search reports failures', () => {
  afterEach(() => {
    fetcher.mockReset();
  });

  it('one failing adapter next to a good one: the good entries plus one failure', async () => {
    serveByUrl();

    const outcome = await manager(DOWN_URL, GOOD_URL).search('tool');

    expect(outcome.entries.map((e) => e.name)).toEqual(['alpha-tool', 'beta-tool']);
    expect(outcome.total).toBe(2);
    expect(outcome.failures).toEqual([
      { registry: 'r0', message: 'no response headers within 15 s' },
    ]);
  });

  it('every adapter failing: no entries, one failure each, no rejection', async () => {
    serveByUrl();

    const outcome = await manager(DOWN_URL, BAD_URL).search('tool');

    expect(outcome.entries).toEqual([]);
    expect(outcome.total).toBe(0);
    expect(outcome.failures.map((f) => f.registry)).toEqual(['r0', 'r1']);
    expect(outcome.failures[1]?.message).toMatch(/^Invalid registry response: /);
    expect(outcome.failures[1]?.message).not.toContain('not an array');
  });

  it('no failures when every registry answers', async () => {
    serveByUrl();

    const outcome = await manager(GOOD_URL).search('beta');

    expect(outcome.entries.map((e) => e.name)).toEqual(['beta-tool']);
    expect(outcome.failures).toEqual([]);
  });

  it('hands the allow-list to the fetcher for every adapter', async () => {
    serveByUrl();

    await manager(GOOD_URL).search('alpha');

    expect(fetcher).toHaveBeenCalledWith(GOOD_URL, { allowPrivateHosts: ['good.example'] });
  });

  it('a body that is not JSON is a failure without the body in the message', async () => {
    fetcher.mockResolvedValue({ status: 200, text: '<html>oops</html>' });

    const outcome = await manager(GOOD_URL).search('x');

    expect(outcome.failures).toEqual([
      { registry: 'r0', message: 'Invalid registry response: not valid JSON' },
    ]);
  });
});
