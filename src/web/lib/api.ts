// Compute paths from window.location so we work under arbitrary reverse-proxy bases
// (nginx /foo/, VSCode tunnels, etc).

export const apiBase =
  typeof window !== 'undefined'
    ? new URL('./api/', window.location.href).pathname
    : '/api/';

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
export type FsUploadResp = { ok: true; path: string; name: string; size: number };

export type PublicSite = { slug: string; url: string; spa: boolean; root: string; cli: boolean };
export type SitesResp = { canPersist: boolean; sites: PublicSite[] };

export type UploadOpts = {
  dir?: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
};

// Files larger than this are uploaded in parallel chunks; smaller ones go in a
// single request. Mirrors the server's per-request limit headroom.
const CHUNK_THRESHOLD = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

/** Send a Blob body via XHR (so we get per-byte upload progress). */
function xhrSend(
  method: string,
  url: string,
  body: Blob,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error(`${method} → ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('network_error'));
    xhr.onabort = () => reject(new Error('aborted'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort());
    }
    xhr.send(body);
  });
}

async function uploadSingle(id: string, file: File, opts: UploadOpts): Promise<FsUploadResp> {
  const params = new URLSearchParams({ name: file.name });
  if (opts.dir) params.set('dir', opts.dir);
  const url = `${apiBase}sessions/${encodeURIComponent(id)}/fs/upload?${params.toString()}`;
  const text = await xhrSend('POST', url, file, (l) => opts.onProgress?.(l, file.size), opts.signal);
  return JSON.parse(text) as FsUploadResp;
}

async function uploadChunked(id: string, file: File, opts: UploadOpts): Promise<FsUploadResp> {
  const init = await req<{ ok: true; uploadId: string; chunkSize: number }>(
    'POST',
    `sessions/${encodeURIComponent(id)}/fs/upload/init`,
    { name: file.name, dir: opts.dir, size: file.size },
  );
  const base = `sessions/${encodeURIComponent(id)}/fs/upload/${encodeURIComponent(init.uploadId)}`;
  const chunkSize = init.chunkSize;
  const total = file.size;
  const chunkCount = Math.max(1, Math.ceil(total / chunkSize));
  const loaded = new Array<number>(chunkCount).fill(0);
  const report = () => opts.onProgress?.(loaded.reduce((a, b) => a + b, 0), total);

  // Bridge the caller's signal with an internal one so a single chunk failure
  // cancels every in-flight chunk.
  const ac = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort());
  }

  let next = 0;
  let failure: Error | null = null;

  const worker = async (): Promise<void> => {
    while (!failure && !ac.signal.aborted) {
      const i = next++;
      if (i >= chunkCount) return;
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, total);
      try {
        await xhrSend(
          'PUT',
          `${apiBase}${base}?offset=${start}`,
          file.slice(start, end),
          (l) => {
            loaded[i] = l;
            report();
          },
          ac.signal,
        );
        loaded[i] = end - start;
        report();
      } catch (e) {
        failure = e as Error;
        ac.abort();
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, chunkCount) }, () => worker()),
  );

  if (failure || ac.signal.aborted) {
    void req('DELETE', base).catch(() => undefined);
    throw failure ?? new Error('aborted');
  }

  return req<FsUploadResp>('POST', `${base}/complete`);
}

function uploadFile(id: string, file: File, opts: UploadOpts = {}): Promise<FsUploadResp> {
  return file.size > CHUNK_THRESHOLD ? uploadChunked(id, file, opts) : uploadSingle(id, file, opts);
}

export type SandboxRuntime =
  | { enabled: false }
  | { enabled: true; root: string; net: boolean; defaultOn: boolean; bypassAvailable: boolean };
export type RuntimeInfo = { defaultCwd: string; sandbox: SandboxRuntime };
export type DirEntry = { name: string; path: string };
export type DirListResp = { dir: string; parent: string | null; entries: DirEntry[] };

export const api = {
  health: () => req<{ ok: boolean; uptime: number; sessions: number }>('GET', 'health'),
  runtime: () => req<RuntimeInfo>('GET', 'runtime'),
  listDirs: (path = '') => req<DirListResp>('GET', `dirs?path=${encodeURIComponent(path)}`),
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
  /** Absolute URL the browser can navigate to download a file (or a dir as .tar.gz). */
  fsDownloadUrl: (id: string, path: string) =>
    `${apiBase}sessions/${encodeURIComponent(id)}/fs/download?path=${encodeURIComponent(path)}`,
  /** Absolute URL to download the full terminal contents (screen + scrollback). */
  sessionExportUrl: (id: string, format: 'txt' | 'html') =>
    `${apiBase}sessions/${encodeURIComponent(id)}/export?format=${format}`,
  fsUpload: uploadFile,
  getShare: (id: string) => req<{ token: string | null }>('GET', `sessions/${id}/share`),
  createShare: (id: string) => req<{ ok: true; token: string }>('POST', `sessions/${id}/share`),
  revokeShare: (id: string) => req<{ ok: true }>('DELETE', `sessions/${id}/share`),
  sharedMeta: (token: string) =>
    req<{ ok: true; title: string; cols: number; rows: number }>('GET', `shared/${encodeURIComponent(token)}`),
  listSites: () => req<SitesResp>('GET', 'sites'),
  createSite: (input: { slug: string; root: string; spa?: boolean }) =>
    req<PublicSite>('POST', 'sites', input),
  deleteSite: (slug: string) => req<{ ok: boolean }>('DELETE', `sites/${encodeURIComponent(slug)}`),
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
