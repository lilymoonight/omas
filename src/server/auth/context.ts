import type { CookieSessionStore } from './sessions.js';
import { UserStore, type UserRecord } from './users.js';
import { userForReq, authRequiredFor } from './routes.js';

/**
 * Request-scoped auth helpers shared by the session routes and the WS upgrade.
 * Lets every per-session handler ask "who is this, and may they touch this
 * session?" without re-plumbing the store/users into each route module.
 */
export type AuthContext = {
  /** True when accounts exist (open mode = false → no ownership enforced). */
  authRequired: () => boolean;
  /** Resolve the logged-in user for a (cookie-bearing) request, or null. */
  userFor: (req: { cookies?: Record<string, string | undefined> }) => UserRecord | null;
  /** Resolve an account id to its username (for display), or null. */
  usernameFor: (id: string) => string | null;
};

export function makeAuthContext(users: UserStore, store: CookieSessionStore): AuthContext {
  return {
    authRequired: () => authRequiredFor(users),
    userFor: (req) => userForReq(req, store, users),
    usernameFor: (id) => (id ? users.byId(id)?.username ?? null : null),
  };
}

/**
 * May `user` access a session owned by `ownerId`? Open mode → everyone; admins →
 * everything; otherwise only the owner. A null user (shouldn't happen once the
 * auth guard has run) is denied.
 */
export function canAccess(ownerId: string, user: UserRecord | null, authRequired: boolean): boolean {
  if (!authRequired) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  return ownerId === user.id;
}
