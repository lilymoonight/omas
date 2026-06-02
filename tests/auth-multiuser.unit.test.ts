import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from '../src/server/auth/users.js';
import { CookieSessionStore } from '../src/server/auth/sessions.js';
import { LoginLimiter } from '../src/server/auth/limiter.js';
import { hashPassword } from '../src/server/auth/password.js';
import { registerAuthRoutes, authRequiredFor } from '../src/server/auth/routes.js';
import { canAccess } from '../src/server/auth/context.js';

describe('canAccess', () => {
  const admin = { id: 'a', username: 'admin', passwordHash: 'h', role: 'admin' as const, createdAt: '' };
  const bob = { id: 'b', username: 'bob', passwordHash: 'h', role: 'user' as const, createdAt: '' };

  it('open mode allows everyone', () => {
    expect(canAccess('whoever', null, false)).toBe(true);
    expect(canAccess('x', bob, false)).toBe(true);
  });
  it('admin sees everything', () => {
    expect(canAccess('someone-else', admin, true)).toBe(true);
  });
  it('owner sees own, not others', () => {
    expect(canAccess('b', bob, true)).toBe(true);
    expect(canAccess('a', bob, true)).toBe(false);
  });
  it('null user denied when auth required', () => {
    expect(canAccess('b', null, true)).toBe(false);
  });
});

// Minimal fake Fastify that captures route handlers so we can invoke them.
function fakeApp() {
  const routes = new Map<string, (req: any, reply: any) => any>();
  return {
    app: {
      get: (p: string, h: any) => routes.set('GET ' + p, h),
      post: (p: string, h: any) => routes.set('POST ' + p, h),
      addHook: () => {},
    },
    call: (key: string, req: any) => {
      const cookies: Record<string, string> = {};
      const reply: any = {
        statusCode: 200,
        body: undefined,
        code(c: number) { this.statusCode = c; return this; },
        send(b: any) { this.body = b; return this; },
        setCookie(name: string, val: string) { cookies[name] = val; },
      };
      const out = routes.get(key)!({ ip: '1.2.3.4', cookies: {}, protocol: 'http', ...req }, reply);
      return Promise.resolve(out).then((ret) => ({ reply, cookies, ret: ret ?? reply.body }));
    },
  };
}

describe('auth routes (multi-user)', () => {
  let dir: string;
  let users: UserStore;
  let store: CookieSessionStore;
  let bobId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-auth-'));
    users = new UserStore(dir);
    users.add({ username: 'admin', passwordHash: await hashPassword('adminpw'), role: 'admin' });
    bobId = users.add({ username: 'bob', passwordHash: await hashPassword('bobpass'), role: 'user', osUser: 'bob' }).id;
    store = new CookieSessionStore();
  });

  it('authRequiredFor reflects account count', () => {
    expect(authRequiredFor(users)).toBe(true);
    expect(authRequiredFor(new UserStore(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))))).toBe(false);
  });

  it('logs in bob and binds the cookie to his user id', async () => {
    const { app, call } = fakeApp();
    registerAuthRoutes(app as any, { users, store, limiter: new LoginLimiter() });
    const { reply, cookies, ret } = await call('POST /api/auth/login', { body: { username: 'bob', password: 'bobpass' } });
    expect(reply.statusCode).toBe(200);
    expect(ret.user.username).toBe('bob');
    const sid = cookies['omas_sid'];
    expect(sid).toBeTruthy();
    expect(store.touch(sid)).toBe(true);
    expect(store.userIdFor(sid)).toBe(bobId);
  });

  it('rejects a wrong password with invalid_credentials', async () => {
    const { app, call } = fakeApp();
    registerAuthRoutes(app as any, { users, store, limiter: new LoginLimiter() });
    const { reply } = await call('POST /api/auth/login', { body: { username: 'bob', password: 'nope' } });
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('invalid_credentials');
  });

  it('rejects an unknown username with invalid_credentials (no enumeration)', async () => {
    const { app, call } = fakeApp();
    registerAuthRoutes(app as any, { users, store, limiter: new LoginLimiter() });
    const { reply } = await call('POST /api/auth/login', { body: { username: 'ghost', password: 'x' } });
    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('invalid_credentials');
  });

  it('requires a username when multiple accounts exist', async () => {
    const { app, call } = fakeApp();
    registerAuthRoutes(app as any, { users, store, limiter: new LoginLimiter() });
    const { reply } = await call('POST /api/auth/login', { body: { password: 'bobpass' } });
    expect(reply.statusCode).toBe(400);
    expect(reply.body.error).toBe('username_required');
  });

  it('/api/auth/me reports multiUser and login state', async () => {
    const { app, call } = fakeApp();
    registerAuthRoutes(app as any, { users, store, limiter: new LoginLimiter() });
    const { ret } = await call('GET /api/auth/me', { cookies: {} });
    expect(ret.authRequired).toBe(true);
    expect(ret.loggedIn).toBe(false);
    expect(ret.multiUser).toBe(true);
  });

  it('single-account setup lets the username be omitted', async () => {
    const soloDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-solo-'));
    const solo = new UserStore(soloDir);
    solo.add({ username: 'admin', passwordHash: await hashPassword('solopw'), role: 'admin' });
    const { app, call } = fakeApp();
    registerAuthRoutes(app as any, { users: solo, store, limiter: new LoginLimiter() });
    const { reply, ret } = await call('POST /api/auth/login', { body: { password: 'solopw' } });
    expect(reply.statusCode).toBe(200);
    expect(ret.user.username).toBe('admin');
  });
});
