import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKey } from '../../shared/session.js';

const exec = promisify(execFile);

export type ForegroundInfo = {
  /** Program basename in the tty foreground group, or null = shell at prompt. */
  foreground: string | null;
  /** Normalized known agent key, or null. */
  agent: AgentKey | null;
};

type ProcRow = { pid: number; ppid: number; stat: string; command: string };

/**
 * Classify a full command line into a known AI-agent key. Agents are often
 * launched through a node/python wrapper, so `comm` would just say "node" —
 * we scan the whole command line for the real tool name. Order matters:
 * `cursor-agent` before any bare `cursor`, `qodercli`/`qoder`, then `claude`.
 */
export function classifyAgent(command: string): AgentKey | null {
  const c = command.toLowerCase();
  if (/(^|[\s/])cursor-agent(\s|$)/.test(c) || c.includes('cursor-agent')) return 'cursor';
  if (/(^|[\s/])qodercli(\s|$)/.test(c) || c.includes('qodercli') || /(^|[\s/])qoder(\s|$)/.test(c)) {
    return 'qoder';
  }
  if (/(^|[\s/])claude(\s|$)/.test(c) || c.includes('claude')) return 'claude';
  return null;
}

/** Basename of the first token of a command line (the executable path). */
export function commandBasename(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return base || first;
}

/** Parse `ps` output rows of the form: "<pid> <ppid> <stat> <command...>". */
export function parsePsRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const stat = m[3]!;
    const command = m[4]!;
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, ppid, stat, command });
  }
  return rows;
}

/**
 * Given a process snapshot and a shell pid, find the program running in the
 * tty's foreground process group. macOS/BSD and Linux both mark foreground
 * processes with a `+` in the STAT column. We walk the shell's descendants and
 * pick a foreground one; if none (only the shell is foreground), the shell is
 * idle at its prompt → null.
 */
export function resolveForeground(rows: ProcRow[], shellPid: number): ForegroundInfo {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const arr = children.get(r.ppid);
    if (arr) arr.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }

  // Collect descendants (excluding the shell itself) that are in the tty
  // foreground process group.
  const fg: ProcRow[] = [];
  const stack = [...(children.get(shellPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) continue;
    if (row.stat.includes('+')) fg.push(row);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }

  if (fg.length === 0) return { foreground: null, agent: null };

  // Prefer a recognized agent; otherwise the deepest foreground process (the
  // leaf the user is actually interacting with) — approximate with the highest
  // pid, which for descendants is a good proxy for "most recently spawned".
  let chosen = fg[0]!;
  for (const r of fg) {
    if (classifyAgent(r.command)) { chosen = r; break; }
    if (r.pid > chosen.pid) chosen = r;
  }
  const agent = classifyAgent(chosen.command);
  return { foreground: agent ?? commandBasename(chosen.command), agent };
}

/** One process snapshot, cached briefly so per-session list polling doesn't storm `ps`. */
const SNAPSHOT_TTL_MS = 1500;
let snapshot: { at: number; rows: ProcRow[] } | null = null;
let inflight: Promise<ProcRow[]> | null = null;

async function psSnapshotUncached(): Promise<ProcRow[]> {
  const args =
    process.platform === 'linux'
      ? ['-eo', 'pid=,ppid=,stat=,command=']
      : ['-axo', 'pid=,ppid=,stat=,command='];
  try {
    const { stdout } = await exec('ps', args, { timeout: 2500, maxBuffer: 8 * 1024 * 1024 });
    return parsePsRows(stdout);
  } catch {
    return [];
  }
}

async function psSnapshot(): Promise<ProcRow[]> {
  const now = Date.now();
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.rows;
  if (inflight) return inflight;
  inflight = psSnapshotUncached()
    .then((rows) => {
      snapshot = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Resolve foreground/agent info for many shell pids from a single ps snapshot. */
export async function foregroundForPids(
  pids: Array<number | null>,
): Promise<Map<number, ForegroundInfo>> {
  const out = new Map<number, ForegroundInfo>();
  const valid = pids.filter((p): p is number => typeof p === 'number' && p > 0);
  if (valid.length === 0) return out;
  const rows = await psSnapshot();
  if (rows.length === 0) return out;
  for (const pid of valid) out.set(pid, resolveForeground(rows, pid));
  return out;
}

export function clearForegroundSnapshot(): void {
  snapshot = null;
}
