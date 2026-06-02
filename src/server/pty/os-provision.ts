import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serverIsRoot } from './os-user.js';

const pexec = promisify(execFile);

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Whether omas can provision OS users on this platform (Linux only). */
export function canProvisionOsUsers(): boolean {
  return process.platform === 'linux';
}

/**
 * Create a real UNIX account (Linux only). Creates the home directory and
 * *locks* the account's own password, since login is authenticated by omas
 * (app-managed argon2id) rather than the system password — no PAM needed.
 */
export async function createOsUser(name: string, opts: { shell?: string } = {}): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`invalid os user name: ${name}`);
  if (!canProvisionOsUsers()) {
    throw new Error('creating OS users is only supported on Linux; on macOS map to an existing user with --os-user');
  }
  if (!serverIsRoot()) throw new Error('creating an OS user requires running as root');

  const args = ['--create-home'];
  if (opts.shell) args.push('--shell', opts.shell);
  args.push(name);
  try {
    await pexec('useradd', args, { timeout: 20_000 });
  } catch (err: any) {
    // useradd exit 9 = name already in use.
    if (err?.code === 9) throw new Error(`OS user already exists: ${name}`);
    throw new Error(`useradd failed: ${err?.stderr?.toString().trim() || err?.message || err}`);
  }
  // Lock the system password so the account can't log in via the OS directly.
  await pexec('usermod', ['--lock', name], { timeout: 10_000 }).catch(() => {});
}

/**
 * Remove a UNIX account and its home directory (Linux only). Destructive — only
 * call when the operator explicitly opted in (`--purge-os-user`).
 */
export async function deleteOsUser(name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`invalid os user name: ${name}`);
  if (!canProvisionOsUsers()) throw new Error('removing OS users is only supported on Linux');
  if (!serverIsRoot()) throw new Error('removing an OS user requires running as root');
  try {
    await pexec('userdel', ['--remove', name], { timeout: 30_000 });
  } catch (err: any) {
    throw new Error(`userdel failed: ${err?.stderr?.toString().trim() || err?.message || err}`);
  }
}
