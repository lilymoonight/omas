// Tiny per-IP login limiter. Sliding window: 5 fails in 5 min → block for 5 min.
// Argon2 verify is intentionally slow (~50ms) so this is mostly to stop log floods.

type Entry = { fails: number; firstFailAt: number; blockedUntil: number };

const WINDOW_MS = 5 * 60 * 1000;
const BLOCK_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;

export class LoginLimiter {
  private readonly byIp = new Map<string, Entry>();

  isBlocked(ip: string): boolean {
    const e = this.byIp.get(ip);
    if (!e) return false;
    if (e.blockedUntil > Date.now()) return true;
    if (Date.now() - e.firstFailAt > WINDOW_MS) {
      this.byIp.delete(ip);
      return false;
    }
    return false;
  }

  recordFail(ip: string): void {
    const now = Date.now();
    const e = this.byIp.get(ip);
    if (!e || now - e.firstFailAt > WINDOW_MS) {
      this.byIp.set(ip, { fails: 1, firstFailAt: now, blockedUntil: 0 });
      return;
    }
    e.fails += 1;
    if (e.fails >= MAX_FAILS) e.blockedUntil = now + BLOCK_MS;
  }

  recordSuccess(ip: string): void {
    this.byIp.delete(ip);
  }
}
