import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { verifyPassword, hashPassword } from './password.js';
import type { CookieSessionStore } from './sessions.js';
import type { LoginLimiter } from './limiter.js';
import { UserStore, toPublic, type UserRecord } from './users.js';

// A throwaway valid hash to verify against when the username is unknown, so a
// failed login costs the same time whether or not the account exists.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  return (dummyHashPromise ??= hashPassword(randomBytes(16).toString('hex')));
}

const COOKIE = 'omas_sid';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30d

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  addHook: (event: 'preHandler', handler: (req: any, reply: any) => any) => unknown;
};

const loginSchema = z.object({
  username: z.string().min(1).max(64).optional(),
  password: z.string().min(1),
});

export type AuthDeps = {
  users: UserStore;
  store: CookieSessionStore;
  limiter: LoginLimiter;
};

/** Auth is required whenever at least one account exists; zero accounts = open mode. */
export function authRequiredFor(users: UserStore): boolean {
  return users.count() > 0;
}

export function isAuthed(req: { cookies?: Record<string, string | undefined> }, store: CookieSessionStore): boolean {
  const sid = req.cookies?.[COOKIE];
  if (!sid) return false;
  return store.touch(sid);
}

export function isAuthedFromRawHeaders(req: { headers: { cookie?: string } }, store: CookieSessionStore): boolean {
  const raw = req.headers.cookie;
  if (!raw) return false;
  const sid = parseCookieHeader(raw, COOKIE);
  if (!sid) return false;
  return store.touch(sid);
}

/** Resolve the logged-in user for a request (cookie → session → user), or null. */
export function userForReq(
  req: { cookies?: Record<string, string | undefined> },
  store: CookieSessionStore,
  users: UserStore,
): UserRecord | null {
  const sid = req.cookies?.[COOKIE];
  if (!sid || !store.touch(sid)) return null;
  const uid = store.userIdFor(sid);
  return uid ? users.byId(uid) ?? null : null;
}

/** Same as `userForReq` but from raw upgrade-request headers (WebSocket). */
export function userForRawHeaders(
  req: { headers: { cookie?: string } },
  store: CookieSessionStore,
  users: UserStore,
): UserRecord | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const sid = parseCookieHeader(raw, COOKIE);
  if (!sid || !store.touch(sid)) return null;
  const uid = store.userIdFor(sid);
  return uid ? users.byId(uid) ?? null : null;
}

function parseCookieHeader(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export function registerAuthRoutes(app: App, deps: AuthDeps): void {
  app.get('/api/auth/me', async (req: any) => {
    const authRequired = authRequiredFor(deps.users);
    if (!authRequired) return { authRequired: false, loggedIn: true, user: null };
    const user = userForReq(req, deps.store, deps.users);
    return {
      authRequired: true,
      loggedIn: !!user,
      user: user ? toPublic(user) : null,
      // Whether the client should ask for a username (more than one account).
      multiUser: deps.users.count() > 1,
    };
  });

  app.post('/api/auth/login', async (req: any, reply: any) => {
    if (!authRequiredFor(deps.users)) {
      return { ok: true, authRequired: false };
    }
    const ip = req.ip ?? 'unknown';
    if (deps.limiter.isBlocked(ip)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'too many attempts; try again later' });
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    // Resolve which account to verify against: an explicit username, or the sole
    // account when there's exactly one (so single-user setups can omit it).
    const user = parsed.data.username
      ? deps.users.byUsername(parsed.data.username)
      : deps.users.sole();
    if (!parsed.data.username && !user) {
      return reply.code(400).send({ error: 'username_required', message: 'multiple accounts: a username is required' });
    }

    // Verify even when the user is unknown (constant-ish work) to avoid leaking
    // which usernames exist via timing.
    const hash = user?.passwordHash ?? (await dummyHash());
    const ok = await verifyPassword(hash, parsed.data.password);
    if (!user || !ok) {
      deps.limiter.recordFail(ip);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    deps.limiter.recordSuccess(ip);
    const sid = deps.store.create(user.id);
    reply.setCookie(COOKIE, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: COOKIE_MAX_AGE,
    });
    return { ok: true, user: toPublic(user) };
  });

  app.post('/api/auth/logout', async (req: any, reply: any) => {
    const sid = req.cookies?.[COOKIE];
    if (sid) deps.store.destroy(sid);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}

// preHandler guard: 401 on /api/* (except auth + health), pass-through elsewhere.
export function makeAuthGuard(users: UserStore, store: CookieSessionStore) {
  return async (req: any, reply: any) => {
    if (!authRequiredFor(users)) return;
    const url: string = req.url ?? '';
    if (!url.startsWith('/api/')) return;
    if (url.startsWith('/api/auth/') || url.startsWith('/api/health')) return;
    // Public read-only share metadata (the token is the capability). The matching
    // share WS attach is authorized separately in the upgrade handler.
    if (url.startsWith('/api/shared/')) return;
    if (!isAuthed(req, store)) {
      reply.code(401).send({ error: 'unauthenticated' });
    }
  };
}
