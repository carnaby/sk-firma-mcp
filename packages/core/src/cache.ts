// In-memory LRU + TTL. Map v JS iteruje v poradí vloženia — re-insert pri get
// robí z Map lacnú LRU frontu bez ďalšej štruktúry.
interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruCache<V> {
  private map = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();
  constructor(private opts: { maxSize: number }) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.map.size > this.opts.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /**
   * Cache + single-flight: súbežné dopyty na rovnaký kľúč zdieľajú jeden
   * loader. Bez toho 10 ľudí, čo naraz preveruje tú istú firmu, = 10 dopytov
   * na štátne API (cache sa plní až po dobehnutí prvého).
   */
  async getOrLoad(key: string, ttlMs: number, loader: () => Promise<V>, shouldCache: (v: V) => boolean = () => true): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const v = await loader();
        if (shouldCache(v)) this.set(key, v, ttlMs);
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
