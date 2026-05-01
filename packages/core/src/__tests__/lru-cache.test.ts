import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LruCache } from '../indexer/lru-cache.js';

describe('LruCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values', () => {
    const cache = new LruCache<number>();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    const cache = new LruCache<number>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts oldest entry when max size reached', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('expires entries after TTL', () => {
    const cache = new LruCache<number>(100, 1000);
    cache.set('a', 1);

    vi.advanceTimersByTime(500);
    expect(cache.get('a')).toBe(1);

    vi.advanceTimersByTime(600);
    expect(cache.get('a')).toBeUndefined();
  });

  it('promotes recently accessed items', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('clear removes all entries', () => {
    const cache = new LruCache<number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
