import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** Resolved UNIX account that a session can be launched as (Model B). */
export type OsUserInfo = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Whether the server process can drop privileges (i.e. is running as root). */
export function serverIsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Look up a real UNIX account by name. Linux uses `getent passwd`; macOS uses
 * `dscacheutil`. Throws if the account doesn't exist or the platform is
 * unsupported, so callers fail loudly rather than silently running as root.
 */
export async function resolveOsUser(name: string): Promise<OsUserInfo> {
  if (!NAME_RE.test(name)) throw new Error(`invalid os user name: ${name}`);

  if (process.platform === 'linux') {
    const { stdout } = await pexec('getent', ['passwd', name], { timeout: 5000 });
    const line = stdout.split('\n').find((l) => l.length > 0);
    if (!line) throw new Error(`os user not found: ${name}`);
    // name:passwd:uid:gid:gecos:home:shell
    const p = line.split(':');
    const uid = Number(p[2]);
    const gid = Number(p[3]);
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) {
      throw new Error(`malformed passwd entry for ${name}`);
    }
    return { name: p[0] || name, uid, gid, home: p[5] || `/home/${name}`, shell: p[6] || '/bin/sh' };
  }

  if (process.platform === 'darwin') {
    const { stdout } = await pexec('dscacheutil', ['-q', 'user', '-a', 'name', name], { timeout: 5000 });
    const field = (k: string) =>
      stdout.split('\n').find((l) => l.startsWith(k + ':'))?.slice(k.length + 1).trim();
    const uid = field('uid');
    if (!uid) throw new Error(`os user not found: ${name}`);
    return {
      name,
      uid: Number(uid),
      gid: Number(field('gid') ?? '20'),
      home: field('dir') ?? `/Users/${name}`,
      shell: field('shell') ?? '/bin/zsh',
    };
  }

  throw new Error(`os-user sessions are not supported on ${process.platform}`);
}

/**
 * Wrap a command so it runs as `info` instead of the (root) server. Linux uses
 * `runuser` (util-linux; no password, sets up the supplementary groups and runs
 * the command directly under our PTY). macOS uses `sudo -u` (passwordless for
 * root). The target's HOME/USER/etc. are set by the caller via the PTY env.
 */
export function buildPrivilegeDrop(
  platform: NodeJS.Platform,
  info: OsUserInfo,
  file: string,
  args: string[],
): { file: string; args: string[] } {
  if (platform === 'linux') {
    return { file: 'runuser', args: ['-u', info.name, '--', file, ...args] };
  }
  if (platform === 'darwin') {
    return { file: 'sudo', args: ['-H', '-u', info.name, '--', file, ...args] };
  }
  throw new Error(`privilege drop unsupported on ${platform}`);
}
