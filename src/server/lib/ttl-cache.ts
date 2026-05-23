/** Simple in-memory TTL cache for hot API paths (git status, system stats, …). */
export class TtlCache<K, V> {
  private readonly store = new Map<K, { at: number; value: V }>();

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { at: Date.now(), value });
  }

  delete(key: K): void {
    this.store.delete(key);
  }
}
