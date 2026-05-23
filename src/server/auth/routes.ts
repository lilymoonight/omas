import { z } from 'zod';
import { verifyPassword } from './password.js';
import type { CookieSessionStore } from './sessions.js';
import type { LoginLimiter } from './limiter.js';
import { isAuthRequired, type Config } from '../config.js';

const COOKIE = 'omas_sid';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30d

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  addHook: (event: 'preHandler', handler: (req: any, reply: any) => any) => unknown;
};

const loginSchema = z.object({ password: z.string().min(1) });

export type AuthDeps = {
  config: Config;
  store: CookieSessionStore;
  limiter: LoginLimiter;
};

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

function parseCookieHeader(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export function registerAuthRoutes(app: App, deps: AuthDeps): void {
  app.get('/api/auth/me', async (req: any) => {
    const authRequired = isAuthRequired(deps.config);
    return {
      authRequired,
      loggedIn: authRequired ? isAuthed(req, deps.store) : true,
    };
  });

  app.post('/api/auth/login', async (req: any, reply: any) => {
    if (!isAuthRequired(deps.config)) {
      return { ok: true, authRequired: false };
    }
    const ip = req.ip ?? 'unknown';
    if (deps.limiter.isBlocked(ip)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'too many attempts; try again later' });
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ok = await verifyPassword(deps.config.passwordHash!, parsed.data.password);
    if (!ok) {
      deps.limiter.recordFail(ip);
      return reply.code(401).send({ error: 'invalid_password' });
    }
    deps.limiter.recordSuccess(ip);
    const sid = deps.store.create();
    reply.setCookie(COOKIE, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: COOKIE_MAX_AGE,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req: any, reply: any) => {
    const sid = req.cookies?.[COOKIE];
    if (sid) deps.store.destroy(sid);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}

// preHandler guard: 401 on /api/* (except auth + health), pass-through elsewhere.
export function makeAuthGuard(config: Config, store: CookieSessionStore) {
  return async (req: any, reply: any) => {
    if (!isAuthRequired(config)) return;
    const url: string = req.url ?? '';
    if (!url.startsWith('/api/')) return;
    if (url.startsWith('/api/auth/') || url.startsWith('/api/health')) return;
    if (!isAuthed(req, store)) {
      reply.code(401).send({ error: 'unauthenticated' });
    }
  };
}
