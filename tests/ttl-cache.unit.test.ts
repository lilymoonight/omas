import { describe, it, expect, vi } from 'vitest';
import { TtlCache } from '../src/server/lib/ttl-cache.js';

describe('TtlCache', () => {
  it('returns cached value within TTL', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('a', 42);
    expect(cache.get('a')).toBe(42);
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(100);
    cache.set('a', 1);
    vi.advanceTimersByTime(101);
    expect(cache.get('a')).toBeUndefined();
    vi.useRealTimers();
  });
});
