import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { acquireUpstreamSlot, resetUpstreamState, upstreamStats } from '../src/upstream.js';
import { BusyError } from '../src/errors.js';
import { LruCache } from '../src/cache.js';

const env = { ...process.env };
beforeEach(() => resetUpstreamState());
afterEach(() => { process.env = { ...env }; resetUpstreamState(); });

describe('upstream guard', () => {
  it('plná fronta → BusyError hneď, nečaká sa', async () => {
    process.env.SKFIRMA_UPSTREAM_MAX_QUEUE = '2';
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => acquireUpstreamSlot('q.test')));
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BusyError);
    expect(upstreamStats().find((s) => s.host === 'q.test')!.rejected).toBe(rejected.length);
  });

  it('denný rozpočet na host → BusyError s Retry-After do polnoci', async () => {
    process.env.SKFIRMA_UPSTREAM_DAILY_BUDGET = '1';
    await acquireUpstreamSlot('b.test');
    const err = await acquireUpstreamSlot('b.test').catch((e) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect(err.message).toMatch(/denný limit/);
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(err.retryAfterSec).toBeLessThanOrEqual(86_400);
    // iný host má vlastný rozpočet
    await expect(acquireUpstreamSlot('c.test')).resolves.toBeUndefined();
  });
});

describe('LruCache.getOrLoad (single-flight)', () => {
  it('súbežné dopyty na rovnaký kľúč = jeden loader', async () => {
    const cache = new LruCache<number>({ maxSize: 10 });
    let calls = 0;
    const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 42; };
    const vals = await Promise.all(Array.from({ length: 10 }, () => cache.getOrLoad('k', 1000, loader)));
    expect(vals).toEqual(Array(10).fill(42));
    expect(calls).toBe(1);
    await cache.getOrLoad('k', 1000, loader); // už z cache
    expect(calls).toBe(1);
  });

  it('chyba loadera sa necachuje, ďalší pokus ide znova', async () => {
    const cache = new LruCache<number>({ maxSize: 10 });
    let calls = 0;
    const loader = async () => { calls++; if (calls === 1) throw new Error('boom'); return 1; };
    await expect(cache.getOrLoad('k', 1000, loader)).rejects.toThrow('boom');
    await expect(cache.getOrLoad('k', 1000, loader)).resolves.toBe(1);
  });

  it('shouldCache=false → výsledok sa nevloží do cache', async () => {
    const cache = new LruCache<string>({ maxSize: 10 });
    let calls = 0;
    const loader = async () => { calls++; return 'unavailable'; };
    await cache.getOrLoad('k', 1000, loader, (v) => v !== 'unavailable');
    await cache.getOrLoad('k', 1000, loader, (v) => v !== 'unavailable');
    expect(calls).toBe(2);
  });
});
