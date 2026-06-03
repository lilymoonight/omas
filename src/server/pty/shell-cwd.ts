import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildProcIndex,
  commandBasename,
  getProcessSnapshot,
  pickForegroundRow,
  subtreePids,
  type ProcRow,
} from './foreground.js';

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

/** Read the cwd of a specific process, or null if unavailable. */
export async function shellCwd(pid: number | null): Promise<string | null> {
  if (!pid) return null;
  const hit = cwdCache.get(pid);
  if (hit && Date.now() - hit.at < CWD_CACHE_TTL_MS) return hit.cwd;
  const cwd = await shellCwdUncached(pid);
  cwdCache.set(pid, { at: Date.now(), cwd });
  return cwd;
}

/** Deepest shell descendant of the PTY root (matches session.shell basename). */
export function findShellPid(
  rows: ProcRow[],
  ptyRootPid: number,
  shellPath: string,
  index: ReturnType<typeof buildProcIndex>,
): number | null {
  const want = path.basename(shellPath).toLowerCase();
  let best: number | null = null;
  for (const pid of subtreePids(rows, ptyRootPid, index.children)) {
    const row = index.byPid.get(pid);
    if (!row) continue;
    if (commandBasename(row.command).toLowerCase() !== want) continue;
    if (best == null || pid > best) best = pid;
  }
  return best;
}

/**
 * PID whose cwd tracks `cd` for a session. The PTY root is often a wrapper
 * (runuser / bwrap / sudo) whose cwd stays at the spawn dir; prefer the
 * foreground app when present, otherwise the interactive shell child.
 */
export function cwdTargetPid(
  rows: ProcRow[],
  ptyRootPid: number,
  shellPath: string,
  index: ReturnType<typeof buildProcIndex>,
): number {
  const fg = pickForegroundRow(rows, ptyRootPid, index);
  if (fg) return fg.pid;
  return findShellPid(rows, ptyRootPid, shellPath, index) ?? ptyRootPid;
}

export async function shellCwdForSession(
  ptyRootPid: number | null,
  shellPath: string,
): Promise<string | null> {
  if (!ptyRootPid) return null;
  const rows = await getProcessSnapshot();
  const index = buildProcIndex(rows);
  const target = cwdTargetPid(rows, ptyRootPid, shellPath, index);
  return shellCwd(target);
}

/** One `lsof` for all pids; parse `-Fpn` output into pid → cwd. */
async function lsofCwdMany(pids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (pids.length === 0) return out;
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

async function readCwdMany(pids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const now = Date.now();
  const miss: number[] = [];
  for (const pid of pids) {
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

  await Promise.all(
    miss.map(async (pid) => {
      const cwd = await shellCwdUncached(pid);
      cwdCache.set(pid, { at: Date.now(), cwd });
      out.set(pid, cwd);
    }),
  );
  return out;
}

/**
 * Resolve live cwd for many sessions at once. Keys are PTY root pids (session.pid).
 * On macOS this collapses N per-pid `lsof` spawns into one batch for all targets.
 */
export async function shellCwdMany(
  items: Array<{ pid: number | null; shell: string }>,
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const rows = await getProcessSnapshot();
  const index = buildProcIndex(rows);
  const targetByRoot = new Map<number, number>();
  for (const { pid, shell } of items) {
    if (!pid) continue;
    targetByRoot.set(pid, cwdTargetPid(rows, pid, shell, index));
  }
  const cwdByTarget = await readCwdMany([...new Set(targetByRoot.values())]);
  for (const [root, target] of targetByRoot) {
    out.set(root, cwdByTarget.get(target) ?? null);
  }
  return out;
}

export function clearShellCwdCache(pid?: number): void {
  if (pid == null) cwdCache.clear();
  else cwdCache.delete(pid);
}
