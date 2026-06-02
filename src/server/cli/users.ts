import { hashPassword } from '../auth/password.js';
import { loadConfig, resolveConfigDir } from '../config.js';
import {
  UserStore,
  usersPath,
  isValidUsername,
  migrateLegacyPassword,
  type UserRole,
} from '../auth/users.js';
import { createOsUser, deleteOsUser, canProvisionOsUsers } from '../pty/os-provision.js';
import { resolveOsUser } from '../pty/os-user.js';
import { readPasswordTwice } from './init.js';

/** Load the account store, folding in any legacy single-password admin first so
 *  the CLI and the server always agree on the account set. */
function openStore(configDir?: string): { dir: string; store: UserStore } {
  const dir = resolveConfigDir(configDir);
  const store = new UserStore(dir);
  store.load();
  const cfg = loadConfig(dir);
  if (migrateLegacyPassword(store, cfg?.passwordHash)) store.save();
  return { dir, store };
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

export async function runUserAdd(opts: {
  username: string;
  configDir?: string;
  role?: string;
  osUser?: string;
  createOsUser?: boolean;
  shell?: string;
}): Promise<void> {
  const { dir, store } = openStore(opts.configDir);
  const username = opts.username;
  if (!isValidUsername(username)) fail(`invalid username (allowed: letters, digits, . _ -): ${username}`, 2);
  if (store.byUsername(username)) fail(`user already exists: ${username}`, 2);

  const role: UserRole = opts.role === 'admin' ? 'admin' : opts.role === 'user' ? 'user'
    // First account defaults to admin; subsequent default to a normal user.
    : store.count() === 0 ? 'admin' : 'user';

  // Resolve the OS mapping (Model B). --create-os-user provisions a new Linux
  // account; --os-user maps to an existing one (verified to exist).
  let osUser = opts.osUser;
  let managed = false;
  if (opts.createOsUser) {
    osUser = osUser ?? username;
    if (!canProvisionOsUsers()) {
      fail('creating OS users is only supported on Linux; on macOS use --os-user <existing>', 2);
    }
    try {
      await createOsUser(osUser, { shell: opts.shell });
    } catch (err) {
      fail(`failed to create OS user: ${(err as Error).message}`, 1);
    }
    managed = true;
    console.log(`created OS user '${osUser}' (home + locked system password)`);
  } else if (osUser) {
    try {
      await resolveOsUser(osUser);
    } catch (err) {
      fail(`--os-user '${osUser}' not found: ${(err as Error).message}`, 2);
    }
  }

  const password = await readPasswordTwice(`password for ${username} (min 6 chars)`);
  const hash = await hashPassword(password);
  store.add({ username, passwordHash: hash, role, osUser, managed });
  store.save();

  console.log(`added ${role} '${username}'${osUser ? ` → UNIX user '${osUser}'` : ''}`);
  console.log(`wrote ${usersPath(dir)} (mode 0600)`);
  if (osUser) {
    console.log('note: the server must run as root to launch sessions as this UNIX user.');
  }
  console.log('restart the server for the change to take effect.');
}

export async function runUserList(opts: { configDir?: string }): Promise<void> {
  const { store } = openStore(opts.configDir);
  const users = store.list();
  if (users.length === 0) {
    console.log('no accounts (open mode — anyone can connect).');
    return;
  }
  const rows = users.map((u) => ({
    username: u.username,
    role: u.role,
    osUser: u.osUser ?? '-',
    managed: u.managed ? 'yes' : '-',
    id: u.id,
  }));
  const w = (k: keyof typeof rows[number]) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const widths = { username: w('username'), role: w('role'), osUser: w('osUser'), managed: w('managed') };
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `${pad('USERNAME', widths.username)}  ${pad('ROLE', widths.role)}  ${pad('OS-USER', widths.osUser)}  ${pad('MANAGED', widths.managed)}  ID`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.username, widths.username)}  ${pad(r.role, widths.role)}  ${pad(r.osUser, widths.osUser)}  ${pad(r.managed, widths.managed)}  ${r.id}`,
    );
  }
}

export async function runUserPasswd(opts: { username: string; configDir?: string }): Promise<void> {
  const { store } = openStore(opts.configDir);
  const u = store.byUsername(opts.username);
  if (!u) fail(`no such user: ${opts.username}`, 2);
  const password = await readPasswordTwice(`new password for ${opts.username} (min 6 chars)`);
  store.setPassword(u.id, await hashPassword(password));
  store.save();
  console.log(`password updated for '${opts.username}'. restart the server to invalidate old logins if needed.`);
}

export async function runUserRemove(opts: {
  username: string;
  configDir?: string;
  purgeOsUser?: boolean;
}): Promise<void> {
  const { store } = openStore(opts.configDir);
  const u = store.byUsername(opts.username);
  if (!u) fail(`no such user: ${opts.username}`, 2);

  const admins = store.list().filter((x) => x.role === 'admin');
  if (u.role === 'admin' && admins.length === 1) {
    console.warn('warning: removing the last admin account — the server will fall back to open mode.');
  }

  store.remove(u.id);
  store.save();
  console.log(`removed account '${opts.username}'.`);

  if (opts.purgeOsUser) {
    if (!u.osUser) {
      console.log('no OS user mapped; nothing to purge.');
    } else if (!u.managed) {
      console.log(`OS user '${u.osUser}' was not created by omas — left untouched. Remove it manually if intended.`);
    } else {
      try {
        await deleteOsUser(u.osUser);
        console.log(`purged OS user '${u.osUser}' and its home directory.`);
      } catch (err) {
        fail(`account removed, but purging OS user failed: ${(err as Error).message}`, 1);
      }
    }
  } else if (u.osUser && u.managed) {
    console.log(`note: OS user '${u.osUser}' kept. Pass --purge-os-user to also delete it and its home.`);
  }
  console.log('restart the server for the change to take effect.');
}
