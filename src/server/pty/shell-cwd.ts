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

/**
 * Resolve cwd for many pids at once. On macOS this collapses N per-pid `lsof`
 * spawns (the dominant cost of `GET /api/sessions` polling) into a SINGLE
 * `lsof` call for all cache-missing pids; Linux stays per-pid `/proc` readlinks
 * (already cheap). Results are written through the same per-pid TTL cache.
 */
export async function shellCwdMany(pids: Array<number | null>): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const now = Date.now();
  const miss: number[] = [];
  for (const pid of pids) {
    if (!pid) continue;
    if (out.has(pid)) continue;
    const hit = cwdCache.get(pid);
    if (hit && now - hit.at < CWD_CACHE_TTL_MS) out.set(pid, hit.cwd);
    else miss.push(pid);
  }
  if (miss.length === 0) return out;

  if (process.platform === 'darwin') {
    const resolved = await lsofCwdMany(miss);
    const at = Date.now();
    for (const pid of miss) {
      const cwd = resolved.get(pid) ?? null;
      cwdCache.set(pid, { at, cwd });
      out.set(pid, cwd);
    }
    return out;
  }

  // Linux / other: per-pid readlink is cheap; run in parallel.
  await Promise.all(
    miss.map(async (pid) => {
      const cwd = await shellCwdUncached(pid);
      cwdCache.set(pid, { at: Date.now(), cwd });
      out.set(pid, cwd);
    }),
  );
  return out;
}

/** One `lsof` for all pids; parse `-Fpn` output into pid → cwd. */
async function lsofCwdMany(pids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  try {
    const { stdout } = await exec(
      'lsof',
      ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
    );
    let cur: number | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        const n = Number(line.slice(1));
        cur = Number.isFinite(n) ? n : null;
      } else if (line.startsWith('n') && cur != null && !out.has(cur)) {
        out.set(cur, line.slice(1));
      }
    }
  } catch {
    /* leave unresolved pids as null */
  }
  return out;
}

export function clearShellCwdCache(pid?: number): void {
  if (pid == null) cwdCache.clear();
  else cwdCache.delete(pid);
}
