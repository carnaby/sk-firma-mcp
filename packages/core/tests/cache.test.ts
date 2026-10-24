import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LruCache } from '../src/cache.js';

describe('LruCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('vráti uloženú hodnotu pred expiráciou', () => {
    const c = new LruCache<string>({ maxSize: 10 });
    c.set('a', 'hodnota', 1000);
    expect(c.get('a')).toBe('hodnota');
  });

  it('po TTL vráti undefined', () => {
    const c = new LruCache<string>({ maxSize: 10 });
    c.set('a', 'hodnota', 1000);
    vi.advanceTimersByTime(1001);
    expect(c.get('a')).toBeUndefined();
  });

  it('pri prekročení maxSize zahodí najdlhšie nepoužitú položku', () => {
    const c = new LruCache<number>({ maxSize: 2 });
    c.set('a', 1, 60_000);
    c.set('b', 2, 60_000);
    c.get('a'); // 'a' je teraz čerstvejšia než 'b'
    c.set('c', 3, 60_000);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(2);
  });
});
