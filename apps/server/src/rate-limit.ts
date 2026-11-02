// Fixed-window limiter v pamäti procesu. Stačí pre jednu inštanciu; pri
// škálovaní na viac strojov treba zdieľaný store (Redis) alebo limit na proxy.
// Účel: chrániť verejné štátne API pred tým, aby nás cez ne niekto zahltil.
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(private opts: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }) {}

  get size(): number {
    return this.hits.size;
  }

  /** cost = koľko jednotiek limitu požiadavka spotrebuje (drahšie volania viac) */
  hit(key: string, cost = 1): { allowed: boolean; retryAfterMs: number } {
    const now = this.opts.now?.() ?? Date.now();
    this.sweep(now);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.evictIfFull(now);
      e = { count: 0, resetAt: now + this.opts.windowMs };
      this.hits.set(key, e);
    }
    e.count += cost;
    return e.count <= this.opts.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: e.resetAt - now };
  }

  /** Strop pamäte: pri zaplnení najprv zmaž expirované, potom najstaršie kľúče (Map drží poradie vloženia). */
  private evictIfFull(now: number): void {
    const max = this.opts.maxKeys ?? 50_000;
    if (this.hits.size < max) return;
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
    for (const k of this.hits.keys()) {
      if (this.hits.size < max) break;
      this.hits.delete(k);
    }
  }

  private sweep(now: number): void {
    // aspoň každých 10 min — expirované kľúče (IP adresy) nedržíme v pamäti dlhšie, než treba
    if (now - this.lastSweep < Math.min(this.opts.windowMs, 10 * 60_000)) return;
    this.lastSweep = now;
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
  }
}
