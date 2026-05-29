import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKey, AgentState } from '../../shared/session.js';

const exec = promisify(execFile);

/**
 * CPU usage (in cores, i.e. CPU-seconds per wall-second) above which an agent
 * counts as "active". Output-recency is unreliable because TUI agents repaint
 * a blinking cursor / input box while idle; but that costs ~0% CPU, whereas
 * generating a response or running tools costs real CPU. So we sample the
 * agent process subtree's CPU rate across two `ps` snapshots instead.
 */
export const ACTIVE_CPU_RATE = 0.05;

export type ForegroundInfo = {
  /** Program basename in the tty foreground group, or null = shell at prompt. */
  foreground: string | null;
  /** Normalized known agent key, or null. */
  agent: AgentKey | null;
  /** Agent activity from CPU sampling; only set when `agent` is present. */
  agentState: AgentState | null;
};

type ProcRow = { pid: number; ppid: number; stat: string; cpuTime: number; command: string };

/**
 * Parse a `ps` TIME value (cumulative CPU time) into seconds. Handles the
 * BSD/Linux formats: `ss(.ff)`, `mm:ss(.ff)`, `hh:mm:ss`, and `dd-hh:mm:ss`.
 */
export function parseCpuSeconds(token: string): number {
  const t = token.trim();
  if (!t) return 0;
  let days = 0;
  let rest = t;
  const dash = t.indexOf('-');
  if (dash >= 0) {
    days = Number(t.slice(0, dash)) || 0;
    rest = t.slice(dash + 1);
  }
  const parts = rest.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return days * 86400 + sec;
}

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

/** Parse `ps` rows of the form: "<pid> <ppid> <stat> <time> <command...>". */
export function parsePsRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const stat = m[3]!;
    const cpuTime = parseCpuSeconds(m[4]!);
    const command = m[5]!;
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, ppid, stat, cpuTime, command });
  }
  return rows;
}

/** All pids in the subtree rooted at `rootPid` (inclusive). */
export function subtreePids(rows: ProcRow[], rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const arr = children.get(r.ppid);
    if (arr) arr.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const out: number[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/**
 * CPU rate (in cores) of a process subtree between two cputime snapshots.
 * Returns 0 when the window is non-positive or cputime didn't advance.
 */
export function subtreeCpuRate(
  rows: ProcRow[],
  rootPid: number,
  prev: { at: number; byPid: Map<number, number> },
  cur: { at: number; byPid: Map<number, number> },
): number {
  const dt = (cur.at - prev.at) / 1000;
  if (dt <= 0) return 0;
  let curSum = 0;
  let prevSum = 0;
  for (const pid of subtreePids(rows, rootPid)) {
    curSum += cur.byPid.get(pid) ?? 0;
    prevSum += prev.byPid.get(pid) ?? 0;
  }
  const delta = curSum - prevSum;
  return delta > 0 ? delta / dt : 0;
}

/**
 * Given a process snapshot and a shell pid, find the program running in the
 * tty's foreground process group. macOS/BSD and Linux both mark foreground
 * processes with a `+` in the STAT column. We walk the shell's descendants and
 * pick a foreground one; if none (only the shell is foreground), the shell is
 * idle at its prompt → null.
 */
/**
 * Pick the process the user is interacting with in the shell's tty foreground
 * group, or null when only the shell itself is foreground (idle at prompt).
 */
export function pickForegroundRow(rows: ProcRow[], shellPid: number): ProcRow | null {
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

  if (fg.length === 0) return null;

  // Prefer a recognized agent; otherwise the deepest foreground process (the
  // leaf the user is actually interacting with) — approximate with the highest
  // pid, which for descendants is a good proxy for "most recently spawned".
  let chosen = fg[0]!;
  for (const r of fg) {
    if (classifyAgent(r.command)) { chosen = r; break; }
    if (r.pid > chosen.pid) chosen = r;
  }
  return chosen;
}

export function resolveForeground(
  rows: ProcRow[],
  shellPid: number,
): { foreground: string | null; agent: AgentKey | null } {
  const row = pickForegroundRow(rows, shellPid);
  if (!row) return { foreground: null, agent: null };
  const agent = classifyAgent(row.command);
  return { foreground: agent ?? commandBasename(row.command), agent };
}

/** One process snapshot, cached briefly so per-session list polling doesn't storm `ps`. */
const SNAPSHOT_TTL_MS = 1500;
let snapshot: { at: number; rows: ProcRow[] } | null = null;
let inflight: Promise<ProcRow[]> | null = null;
// Last two distinct snapshots' cputime maps, for CPU-rate sampling.
type CpuSample = { at: number; byPid: Map<number, number> };
let cpuPrev: CpuSample | null = null;
let cpuCur: CpuSample | null = null;

async function psSnapshotUncached(): Promise<ProcRow[]> {
  const args =
    process.platform === 'linux'
      ? ['-eo', 'pid=,ppid=,stat=,time=,command=']
      : ['-axo', 'pid=,ppid=,stat=,time=,command='];
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
      const at = Date.now();
      const byPid = new Map<number, number>();
      for (const r of rows) byPid.set(r.pid, r.cpuTime);
      // Shift current → previous so we always diff against the prior snapshot.
      cpuPrev = cpuCur;
      cpuCur = { at, byPid };
      snapshot = { at, rows };
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
  for (const pid of valid) {
    const row = pickForegroundRow(rows, pid);
    const agent = row ? classifyAgent(row.command) : null;
    const foreground = row ? (agent ?? commandBasename(row.command)) : null;
    let agentState: AgentState | null = null;
    if (agent && row) {
      // Default to idle until we have two snapshots to diff (or if CPU is low).
      const active =
        cpuPrev != null
        && cpuCur != null
        && subtreeCpuRate(rows, row.pid, cpuPrev, cpuCur) >= ACTIVE_CPU_RATE;
      agentState = active ? 'active' : 'idle';
    }
    out.set(pid, { foreground, agent, agentState });
  }
  return out;
}

export function clearForegroundSnapshot(): void {
  snapshot = null;
  cpuPrev = null;
  cpuCur = null;
}
