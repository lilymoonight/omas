import { randomBytes } from 'node:crypto';

export type AuthSession = {
  sid: string;
  /** The logged-in user's id (UserStore record id). Empty in open mode. */
  userId: string;
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

  create(userId = ''): string {
    const sid = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(sid, { sid, userId, createdAt: now, lastSeenAt: now });
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

  /** The user id bound to a session (after a successful `touch`), or undefined. */
  userIdFor(sid: string): string | undefined {
    return this.map.get(sid)?.userId;
  }

  /** Drop every session belonging to a user (e.g. when the account is removed). */
  destroyForUser(userId: string): void {
    for (const [sid, s] of this.map) {
      if (s.userId === userId) this.map.delete(sid);
    }
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
