import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Side-panel polling hits cwd on every fs/git request; cache to avoid lsof storms on macOS. */
const CWD_CACHE_TTL_MS = 1500;
const cwdCache = new Map<number, { at: number; cwd: string | null }>();

async function shellCwdUncached(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        timeout: 2000,
      });
      const line = stdout.split('\n').find((l) => l.startsWith('n'));
      return line ? line.slice(1) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Read the shell process cwd (tracks `cd`), or null if unavailable. */
export async function shellCwd(pid: number | null): Promise<string | null> {
  if (!pid) return null;
  const hit = cwdCache.get(pid);
  if (hit && Date.now() - hit.at < CWD_CACHE_TTL_MS) return hit.cwd;
  const cwd = await shellCwdUncached(pid);
  cwdCache.set(pid, { at: Date.now(), cwd });
  return cwd;
}

export function clearShellCwdCache(pid?: number): void {
  if (pid == null) cwdCache.clear();
  else cwdCache.delete(pid);
}
