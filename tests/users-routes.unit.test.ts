import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from '../src/server/auth/users.js';
import { CookieSessionStore } from '../src/server/auth/sessions.js';
import { hashPassword } from '../src/server/auth/password.js';
import { makeAuthContext } from '../src/server/auth/context.js';
import { registerUserRoutes } from '../src/server/routes/users.js';

// Minimal fake Fastify capturing get/post/patch/delete handlers.
function fakeApp() {
  const routes = new Map<string, (req: any, reply: any) => any>();
  return {
    app: {
      get: (p: string, h: any) => routes.set('GET ' + p, h),
      post: (p: string, h: any) => routes.set('POST ' + p, h),
      patch: (p: string, h: any) => routes.set('PATCH ' + p, h),
      delete: (p: string, h: any) => routes.set('DELETE ' + p, h),
    },
    call: (key: string, req: any) => {
      const reply: any = {
        statusCode: 200,
        body: undefined,
        code(c: number) { this.statusCode = c; return this; },
        send(b: any) { this.body = b; return this; },
      };
      const out = routes.get(key)!({ cookies: {}, params: {}, query: {}, ...req }, reply);
      return Promise.resolve(out).then((ret) => ({ reply, ret: ret ?? reply.body }));
    },
  };
}

describe('user-management routes (admin)', () => {
  let dir: string;
  let users: UserStore;
  let store: CookieSessionStore;
  let adminId: string;
  let bobId: string;
  let adminSid: string;
  let bobSid: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-users-'));
    users = new UserStore(dir);
    adminId = users.add({ username: 'admin', passwordHash: await hashPassword('adminpw'), role: 'admin' }).id;
    bobId = users.add({ username: 'bob', passwordHash: await hashPassword('bobpass'), role: 'user' }).id;
    store = new CookieSessionStore();
    adminSid = store.create(adminId);
    bobSid = store.create(bobId);
  });

  function mount() {
    const { app, call } = fakeApp();
    registerUserRoutes(app as any, { users, store, auth: makeAuthContext(users, store) });
    return call;
  }
  const asAdmin = (extra: any = {}) => ({ cookies: { omas_sid: adminSid }, ...extra });
  const asBob = (extra: any = {}) => ({ cookies: { omas_sid: bobSid }, ...extra });

  it('lists users for an admin', async () => {
    const call = mount();
    const { reply, ret } = await call('GET /api/users', asAdmin());
    expect(reply.statusCode).toBe(200);
    expect(ret.users.map((u: any) => u.username).sort()).toEqual(['admin', 'bob']);
  });

  it('forbids non-admins', async () => {
    const call = mount();
    const { reply } = await call('GET /api/users', asBob());
    expect(reply.statusCode).toBe(403);
  });

  it('creates a user and persists it', async () => {
    const call = mount();
    const { reply } = await call('POST /api/users', asAdmin({ body: { username: 'carol', password: 'carolpw', role: 'user' } }));
    expect(reply.statusCode).toBe(201);
    expect(reply.body.username).toBe('carol');
    expect(users.byUsername('carol')).toBeTruthy();
    // Persisted to disk.
    const reloaded = new UserStore(dir);
    reloaded.load();
    expect(reloaded.byUsername('carol')).toBeTruthy();
  });

  it('rejects a duplicate username', async () => {
    const call = mount();
    const { reply } = await call('POST /api/users', asAdmin({ body: { username: 'bob', password: 'whatever' } }));
    expect(reply.statusCode).toBe(409);
  });

  it('changes a password and drops that user\'s sessions', async () => {
    const call = mount();
    const { reply } = await call('PATCH /api/users/:id', asAdmin({ params: { id: bobId }, body: { password: 'newbobpw' } }));
    expect(reply.statusCode).toBe(200);
    expect(store.touch(bobSid)).toBe(false); // bob's session was invalidated
  });

  it('refuses to demote the last admin', async () => {
    const call = mount();
    const { reply } = await call('PATCH /api/users/:id', asAdmin({ params: { id: adminId }, body: { role: 'user' } }));
    expect(reply.statusCode).toBe(409);
    expect(reply.body.error).toBe('last_admin');
  });

  it('refuses to delete the last admin', async () => {
    const call = mount();
    const { reply } = await call('DELETE /api/users/:id', asAdmin({ params: { id: adminId } }));
    expect(reply.statusCode).toBe(409);
  });

  it('deletes a regular user', async () => {
    const call = mount();
    const { reply, ret } = await call('DELETE /api/users/:id', asAdmin({ params: { id: bobId } }));
    expect(reply.statusCode).toBe(200);
    expect(ret.ok).toBe(true);
    expect(users.byId(bobId)).toBeUndefined();
  });
});
