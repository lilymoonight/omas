import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { UserStore, toPublic, isValidUsername, type UserRole } from '../auth/users.js';
import type { CookieSessionStore } from '../auth/sessions.js';
import type { AuthContext } from '../auth/context.js';
import { serverIsRoot, resolveOsUser } from '../pty/os-user.js';
import { createOsUser, deleteOsUser, canProvisionOsUsers } from '../pty/os-provision.js';

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  patch: (path: string, handler: (req: any, reply: any) => any) => unknown;
  delete: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

export type UserRouteDeps = {
  users: UserStore;
  store: CookieSessionStore;
  auth: AuthContext;
};

const createSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(200),
  role: z.enum(['admin', 'user']).optional(),
  osUser: z.string().min(1).max(64).optional(),
  createOsUser: z.boolean().optional(),
  shell: z.string().min(1).max(256).optional(),
});

const patchSchema = z.object({
  password: z.string().min(6).max(200).optional(),
  role: z.enum(['admin', 'user']).optional(),
  // null clears the mapping; a string maps to an existing UNIX user.
  osUser: z.string().min(1).max(64).nullable().optional(),
});

export function registerUserRoutes(app: App, deps: UserRouteDeps): void {
  const { users, store, auth } = deps;

  /** Resolve the caller and require the admin role; otherwise reply 403. */
  function requireAdmin(req: any, reply: any) {
    const u = auth.userFor(req);
    if (!u || u.role !== 'admin') {
      reply.code(403).send({ error: 'forbidden', message: 'admin only' });
      return null;
    }
    return u;
  }

  app.get('/api/users', async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return reply;
    return {
      users: users.list().map((u) => ({ ...toPublic(u), managed: !!u.managed })),
      provisionable: canProvisionOsUsers(),
      isRoot: serverIsRoot(),
    };
  });

  app.post('/api/users', async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return reply;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const d = parsed.data;

    if (!isValidUsername(d.username)) return reply.code(400).send({ error: 'invalid_username' });
    if (users.byUsername(d.username)) return reply.code(409).send({ error: 'user_exists' });

    const role: UserRole = d.role ?? (users.count() === 0 ? 'admin' : 'user');

    let osUser = d.osUser;
    let managed = false;
    if (d.createOsUser) {
      osUser = osUser ?? d.username;
      if (!canProvisionOsUsers()) {
        return reply.code(400).send({ error: 'provision_unsupported', message: 'creating OS users is Linux-only' });
      }
      if (!serverIsRoot()) {
        return reply.code(503).send({ error: 'not_root', message: 'creating an OS user requires the server to run as root' });
      }
      try {
        await createOsUser(osUser, { shell: d.shell });
      } catch (err) {
        return reply.code(500).send({ error: 'provision_failed', message: (err as Error).message });
      }
      managed = true;
    } else if (osUser) {
      try {
        await resolveOsUser(osUser);
      } catch (err) {
        return reply.code(400).send({ error: 'os_user_not_found', message: (err as Error).message });
      }
    }

    const rec = users.add({ username: d.username, passwordHash: await hashPassword(d.password), role, osUser, managed });
    users.save();
    return reply.code(201).send({ ...toPublic(rec), managed: !!rec.managed });
  });

  app.patch('/api/users/:id', async (req: any, reply: any) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;
    const target = users.byId(req.params.id);
    if (!target) return reply.code(404).send({ error: 'not_found' });

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const d = parsed.data;

    // Don't let the last admin demote themselves into a lockout.
    if (d.role === 'user' && target.role === 'admin') {
      const admins = users.list().filter((u) => u.role === 'admin');
      if (admins.length === 1) return reply.code(409).send({ error: 'last_admin', message: 'cannot demote the last admin' });
    }

    if (d.osUser !== undefined) {
      if (d.osUser === null) {
        target.osUser = undefined;
        target.managed = undefined;
      } else {
        try {
          await resolveOsUser(d.osUser);
        } catch (err) {
          return reply.code(400).send({ error: 'os_user_not_found', message: (err as Error).message });
        }
        target.osUser = d.osUser;
        target.managed = false; // mapping to an existing user — not omas-managed
      }
    }
    if (d.role) target.role = d.role;
    if (d.password) {
      target.passwordHash = await hashPassword(d.password);
      // Force re-login for that user so a changed/compromised password takes hold.
      store.destroyForUser(target.id);
    }
    users.save();
    return { ...toPublic(target), managed: !!target.managed };
  });

  app.delete('/api/users/:id', async (req: any, reply: any) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;
    const target = users.byId(req.params.id);
    if (!target) return reply.code(404).send({ error: 'not_found' });

    if (target.role === 'admin') {
      const admins = users.list().filter((u) => u.role === 'admin');
      if (admins.length === 1) return reply.code(409).send({ error: 'last_admin', message: 'cannot remove the last admin' });
    }

    const purge = String(req.query?.purgeOsUser ?? '') === 'true';
    users.remove(target.id);
    store.destroyForUser(target.id);
    users.save();

    let purged: boolean | 'unmanaged' | 'unsupported' = false;
    if (purge && target.osUser) {
      if (!target.managed) purged = 'unmanaged';
      else if (!canProvisionOsUsers() || !serverIsRoot()) purged = 'unsupported';
      else {
        try {
          await deleteOsUser(target.osUser);
          purged = true;
        } catch (err) {
          return reply.code(500).send({ error: 'purge_failed', message: (err as Error).message, removedAccount: true });
        }
      }
    }
    return { ok: true, purged };
  });
}
