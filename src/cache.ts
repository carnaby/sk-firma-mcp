// In-memory LRU + TTL. Map v JS iteruje v poradí vloženia — re-insert pri get
// robí z Map lacnú LRU frontu bez ďalšej štruktúry.
interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruCache<V> {
  private map = new Map<string, Entry<V>>();
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
}
