import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export type UserRole = 'admin' | 'user';

/** A login account. Credentials are app-managed (argon2id), independent of any
 *  OS password, so we never need PAM. `osUser` (Model B) is the real UNIX account
 *  the user's sessions run as; absent → sessions run as the server's own user. */
export const userRecordSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1).max(64),
  passwordHash: z.string().min(1),
  role: z.enum(['admin', 'user']),
  /** Target UNIX account for this user's sessions (Model B). */
  osUser: z.string().min(1).max(64).optional(),
  /** True when omas itself created the OS account (gate for `--purge-os-user`). */
  managed: z.boolean().optional(),
  createdAt: z.string(),
});
export type UserRecord = z.infer<typeof userRecordSchema>;

const usersFileSchema = z.object({ users: z.array(userRecordSchema) });

/** Public, non-secret view of a user (safe to send to the client). */
export type UserPublic = { id: string; username: string; role: UserRole; osUser: string | null };

const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name) && name.length >= 1 && name.length <= 64;
}

export function toPublic(u: UserRecord): UserPublic {
  return { id: u.id, username: u.username, role: u.role, osUser: u.osUser ?? null };
}

export function usersPath(dir: string): string {
  return path.join(dir, 'users.json');
}

/**
 * Seed an `admin` account from a legacy single login password when no accounts
 * exist yet, so old single-password deployments transparently become user[0].
 * Returns true if it added one (caller decides whether to persist). Shared by
 * the server boot path and the CLI so both see a consistent account set.
 */
export function migrateLegacyPassword(
  users: UserStore,
  passwordHash: string | undefined,
  adminName = 'admin',
): boolean {
  if (users.count() > 0 || !passwordHash) return false;
  users.add({ username: adminName, passwordHash, role: 'admin' });
  return true;
}

/**
 * Disk-backed account registry (`users.json` in the config dir). Loaded once at
 * boot and mutated in memory; every mutation re-persists. File mode is 0600
 * because it holds password hashes.
 */
export class UserStore {
  private users: UserRecord[] = [];

  constructor(private readonly dir: string) {}

  load(): void {
    const file = usersPath(this.dir);
    if (!fs.existsSync(file)) {
      this.users = [];
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.users = usersFileSchema.parse(raw).users;
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = usersPath(this.dir);
    fs.writeFileSync(file, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  list(): UserRecord[] {
    return [...this.users];
  }

  count(): number {
    return this.users.length;
  }

  byId(id: string): UserRecord | undefined {
    return this.users.find((u) => u.id === id);
  }

  byUsername(username: string): UserRecord | undefined {
    return this.users.find((u) => u.username === username);
  }

  /** The sole user, when there's exactly one (lets clients omit the username). */
  sole(): UserRecord | undefined {
    return this.users.length === 1 ? this.users[0] : undefined;
  }

  /**
   * Add a new user (throws on duplicate username). Does NOT persist — call
   * `save()` after. Returns the created record.
   */
  add(input: {
    username: string;
    passwordHash: string;
    role: UserRole;
    osUser?: string;
    managed?: boolean;
  }): UserRecord {
    if (!isValidUsername(input.username)) {
      throw new Error(`invalid username (allowed: letters, digits, . _ -): ${input.username}`);
    }
    if (this.byUsername(input.username)) {
      throw new Error(`user already exists: ${input.username}`);
    }
    const rec: UserRecord = {
      id: randomBytes(8).toString('hex'),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      osUser: input.osUser,
      managed: input.managed,
      createdAt: new Date().toISOString(),
    };
    this.users.push(rec);
    return rec;
  }

  setPassword(id: string, passwordHash: string): boolean {
    const u = this.byId(id);
    if (!u) return false;
    u.passwordHash = passwordHash;
    return true;
  }

  remove(id: string): UserRecord | null {
    const i = this.users.findIndex((u) => u.id === id);
    if (i < 0) return null;
    const [removed] = this.users.splice(i, 1);
    return removed ?? null;
  }
}
