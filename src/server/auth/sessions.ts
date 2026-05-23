import { randomBytes } from 'node:crypto';

export type AuthSession = {
  sid: string;
  createdAt: number;
  lastSeenAt: number;
};

const ONE_DAY = 24 * 60 * 60 * 1000;

export class CookieSessionStore {
  private readonly map = new Map<string, AuthSession>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor(private readonly ttlMs = 30 * ONE_DAY) {
    this.gcTimer = setInterval(() => this.gc(), 60 * 60 * 1000);
    this.gcTimer.unref?.();
  }

  create(): string {
    const sid = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(sid, { sid, createdAt: now, lastSeenAt: now });
    return sid;
  }

  touch(sid: string): boolean {
    const s = this.map.get(sid);
    if (!s) return false;
    const now = Date.now();
    if (now - s.lastSeenAt > this.ttlMs) {
      this.map.delete(sid);
      return false;
    }
    s.lastSeenAt = now;
    return true;
  }

  destroy(sid: string): void {
    this.map.delete(sid);
  }

  gc(): void {
    const now = Date.now();
    for (const [sid, s] of this.map) {
      if (now - s.lastSeenAt > this.ttlMs) this.map.delete(sid);
    }
  }

  shutdown(): void {
    clearInterval(this.gcTimer);
  }
}
