// Compute paths from window.location so we work under arbitrary reverse-proxy bases
// (nginx /foo/, VSCode tunnels, etc).

export const apiBase = new URL('./api/', window.location.href).pathname;

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${apiBase}${path}`;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiBase + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

import type { Session, CreateSessionInput } from '../../shared/session.js';

export type HistorySource = 'claude-code' | 'qoder' | 'cursor-agent' | 'opencode';
export type HistorySession = {
  source: HistorySource;
  id: string;
  cwd: string;
  cwdExists: boolean;
  projectName: string;
  title: string;
  gitBranch: string | null;
  startedAt: string | null;
  lastActivityAt: string;
  messageCount: number;
  resumeCommand: string;
  safeResumeCommand: string | null;
};
/** @deprecated kept for cached SPA bundles during rollout */
export type ClaudeHistorySession = HistorySession;

export type GpuStat = {
  index: number;
  name: string;
  utilization: number;
  memoryUsed: number;
  memoryTotal: number;
  temperature: number;
};
export type SystemStats = {
  cpu: { percent: number; cores: number };
  memory: { total: number; free: number; used: number };
  load: [number, number, number];
  disk: { total: number; free: number; used: number; path: string } | null;
  gpus: GpuStat[] | null;
  uptime: number;
  processUptime: number;
  hostname: string;
  platform: string;
};

export type GitFile = { path: string; index: string; worktree: string; oldPath?: string };
export type GitFileResp =
  | { path: string; kind: 'diff';      diff: string;    clipped: boolean; binary: false; size: number }
  | { path: string; kind: 'untracked'; content: string; clipped: boolean; binary: false; size: number }
  | { path: string; kind: 'deleted';   content: string; clipped: boolean; binary: false; size: number }
  | { path: string; kind: 'content';   content: string; clipped: boolean; binary: false; size: number }
  | { path: string; kind: 'binary';    binary: true;    clipped: false;   size: number };
export type GitStatus =
  | {
      available: true;
      root: string;
      cwd: string;
      branch: { name: string | null; upstream: string | null; ahead: number; behind: number };
      files: GitFile[];
      truncated: boolean;
    }
  | { available: false; reason: 'not_a_repo' | 'git_not_installed' | 'error' | 'no_cwd'; message?: string; cwd?: string };

export type FsEntry = { name: string; path: string; kind: 'file' | 'dir'; size?: number };
export type FsListResp = { root: string; path: string; entries: FsEntry[]; truncated: boolean };
export type FsReadResp =
  | { path: string; content: string; clipped: boolean; binary: false; size: number }
  | { path: string; binary: true; clipped: false; size: number };

export const api = {
  health: () => req<{ ok: boolean; uptime: number; sessions: number }>('GET', 'health'),
  listSessions: () => req<Session[]>('GET', 'sessions'),
  createSession: (input: CreateSessionInput) => req<Session>('POST', 'sessions', input),
  getSession: (id: string) => req<Session>('GET', `sessions/${id}`),
  renameSession: (id: string, title: string) => req<Session>('PATCH', `sessions/${id}`, { title }),
  writeSession: (id: string, data: string) => req<{ ok: boolean }>('POST', `sessions/${id}/input`, { data }),
  deleteSession: (id: string) => req<{ ok: boolean }>('DELETE', `sessions/${id}`),
  systemStats: () => req<SystemStats>('GET', 'system/stats'),
  gitStatus: (id: string) => req<GitStatus>('GET', `sessions/${id}/git-status`),
  gitFile: (id: string, path: string, staged: boolean, view: 'diff' | 'content' = 'diff') =>
    req<GitFileResp>(
      'GET',
      `sessions/${id}/git-file?path=${encodeURIComponent(path)}&staged=${staged}&view=${view}`,
    ),
  saveGitFile: (id: string, path: string, content: string) =>
    req<{ ok: true; path: string; size: number }>('PUT', `sessions/${id}/git-file`, { path, content }),
  fsCwd: (id: string) => req<{ cwd: string }>('GET', `sessions/${id}/fs/cwd`),
  fsList: (id: string, path = '') =>
    req<FsListResp>('GET', `sessions/${id}/fs/list?path=${encodeURIComponent(path)}`),
  fsRead: (id: string, path: string) =>
    req<FsReadResp>('GET', `sessions/${id}/fs/read?path=${encodeURIComponent(path)}`),
  fsWrite: (id: string, path: string, content: string) =>
    req<{ ok: true; path: string; size: number }>('PUT', `sessions/${id}/fs/write`, { path, content }),
  history: (opts?: HistorySource[] | { sources?: HistorySource[]; refresh?: boolean }) => {
    const sources = Array.isArray(opts) ? opts : opts?.sources;
    const refresh = !Array.isArray(opts) && opts?.refresh;
    const params = new URLSearchParams();
    if (sources?.length) params.set('source', sources.join(','));
    if (refresh) params.set('refresh', '1');
    const q = params.toString();
    return req<{ sessions: HistorySession[]; aiSafeAvailable: boolean }>('GET', `history${q ? `?${q}` : ''}`);
  },
};
