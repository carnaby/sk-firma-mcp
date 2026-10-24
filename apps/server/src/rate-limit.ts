// Fixed-window limiter v pamäti procesu. Stačí pre jednu inštanciu; pri
// škálovaní na viac strojov treba zdieľaný store (Redis) alebo limit na proxy.
// Účel: chrániť verejné štátne API pred tým, aby nás cez ne niekto zahltil.
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(private opts: { limit: number; windowMs: number; now?: () => number }) {}

  hit(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.opts.now?.() ?? Date.now();
    this.sweep(now);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.opts.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return e.count <= this.opts.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: e.resetAt - now };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.opts.windowMs) return;
    this.lastSweep = now;
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
  }
}
