// Agent-facing CLI commands: `omas exec`, `omas upload`, `omas download`.
//
// These let a LOCAL agent use a REMOTE omas host as compute: send a shell
// command and read its output, push code in, pull results out — all confined to
// a session's working directory ("workspace"). They reuse the same HTTP auth and
// session-scoped endpoints the web UI uses, so a single domain + TLS reverse
// proxy is all that's needed.
//
// Workspace model: the unit of shared state is the session's cwd, a real
// directory on the host (under the sandbox root when sandboxing is on). Point
// every command at the same `--cwd` (or reuse one `--session`) and they all see
// the same files. Destroying the session never deletes the directory.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeBase, authenticate, authHeaders, type Base } from './connect.js';
import { MAX_REQUEST_BYTES, UPLOAD_CHUNK_BYTES } from '../pty/fs-util.js';

export type AgentOpts = {
  url: string;
  session?: string;
  cwd?: string;
  sandbox?: boolean;
  noSandbox?: boolean;
  bypass?: string;
  password?: string;
  insecure?: boolean;
};

type Workspace = { id: string; ephemeral: boolean };

function buildCreateBody(opts: AgentOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { cols: 80, rows: 24 };
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.noSandbox) {
    body.sandbox = false;
    if (opts.bypass) body.bypass = opts.bypass;
  } else if (opts.sandbox) {
    body.sandbox = true;
  }
  return body;
}

/** Reuse an explicit --session, or spin up an ephemeral one at --cwd. */
async function resolveWorkspace(base: Base, cookie: string, opts: AgentOpts): Promise<Workspace> {
  if (opts.session) return { id: opts.session, ephemeral: false };
  const res = await fetch(`${base.http}/api/sessions`, {
    method: 'POST',
    headers: authHeaders(cookie, true),
    body: JSON.stringify(buildCreateBody(opts)),
  });
  if (!res.ok) throw new Error(`创建会话失败：HTTP ${res.status} ${await res.text()}`);
  const s = (await res.json()) as { id: string };
  return { id: s.id, ephemeral: true };
}

async function destroyWorkspace(base: Base, cookie: string, ws: Workspace): Promise<void> {
  if (!ws.ephemeral) return;
  try {
    await fetch(`${base.http}/api/sessions/${encodeURIComponent(ws.id)}`, {
      method: 'DELETE',
      headers: authHeaders(cookie),
    });
  } catch {
    /* best-effort */
  }
}

async function setup(opts: AgentOpts): Promise<{ base: Base; cookie: string }> {
  const base = normalizeBase(opts.url);
  if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const cookie = await authenticate(base, opts);
  return { base, cookie };
}

// --- exec ---------------------------------------------------------------

export async function runExec(opts: AgentOpts & { command: string; timeoutMs?: number }): Promise<void> {
  if (!opts.command.trim()) throw new Error('缺少要执行的命令（用 -- 后跟命令，如 omas exec host -- ls -la）');
  const { base, cookie } = await setup(opts);
  const ws = await resolveWorkspace(base, cookie, opts);
  let exitCode = 0;
  try {
    const res = await fetch(`${base.http}/api/sessions/${encodeURIComponent(ws.id)}/exec`, {
      method: 'POST',
      headers: authHeaders(cookie, true),
      body: JSON.stringify({ command: opts.command, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }),
    });
    if (!res.ok) throw new Error(`exec 失败：HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as {
      stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean;
    };
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.timedOut) process.stderr.write('\n[omas] 命令超时已被终止\n');
    exitCode = r.exitCode ?? (r.signal ? 1 : 0);
  } finally {
    await destroyWorkspace(base, cookie, ws);
  }
  process.exit(exitCode);
}

// --- upload -------------------------------------------------------------

async function uploadSingle(base: Base, cookie: string, id: string, name: string, dir: string, data: Buffer): Promise<string> {
  const qs = new URLSearchParams({ name, ...(dir ? { dir } : {}) });
  const res = await fetch(`${base.http}/api/sessions/${encodeURIComponent(id)}/fs/upload?${qs}`, {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/octet-stream' },
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`上传失败：HTTP ${res.status} ${await res.text()}`);
  return (await res.json() as { path: string }).path;
}

async function uploadChunked(base: Base, cookie: string, id: string, name: string, dir: string, data: Buffer): Promise<string> {
  const initRes = await fetch(`${base.http}/api/sessions/${encodeURIComponent(id)}/fs/upload/init`, {
    method: 'POST',
    headers: authHeaders(cookie, true),
    body: JSON.stringify({ name, size: data.length, ...(dir ? { dir } : {}) }),
  });
  if (!initRes.ok) throw new Error(`上传初始化失败：HTTP ${initRes.status} ${await initRes.text()}`);
  const { uploadId, chunkSize } = (await initRes.json()) as { uploadId: string; chunkSize: number };
  const size = chunkSize || UPLOAD_CHUNK_BYTES;
  for (let offset = 0; offset < data.length; offset += size) {
    const chunk = data.subarray(offset, Math.min(offset + size, data.length));
    const res = await fetch(`${base.http}/api/sessions/${encodeURIComponent(id)}/fs/upload/${uploadId}?offset=${offset}`, {
      method: 'PUT',
      headers: { ...authHeaders(cookie), 'content-type': 'application/octet-stream' },
      body: new Uint8Array(chunk),
    });
    if (!res.ok) throw new Error(`上传分片失败（offset ${offset}）：HTTP ${res.status}`);
  }
  const done = await fetch(`${base.http}/api/sessions/${encodeURIComponent(id)}/fs/upload/${uploadId}/complete`, {
    method: 'POST',
    headers: authHeaders(cookie),
  });
  if (!done.ok) throw new Error(`上传完成失败：HTTP ${done.status} ${await done.text()}`);
  return (await done.json() as { path: string }).path;
}

export async function runUpload(opts: AgentOpts & { local: string; remoteDir?: string }): Promise<void> {
  const localPath = path.resolve(opts.local);
  let data: Buffer;
  try {
    data = fs.readFileSync(localPath);
  } catch (err: any) {
    throw new Error(`无法读取本地文件 ${localPath}：${err?.message ?? err}`);
  }
  const name = path.basename(localPath);
  const { base, cookie } = await setup(opts);
  const ws = await resolveWorkspace(base, cookie, opts);
  try {
    const remote = data.length <= MAX_REQUEST_BYTES
      ? await uploadSingle(base, cookie, ws.id, name, opts.remoteDir ?? '', data)
      : await uploadChunked(base, cookie, ws.id, name, opts.remoteDir ?? '', data);
    process.stdout.write(`${remote}\n`);
  } finally {
    await destroyWorkspace(base, cookie, ws);
  }
}

// --- download -----------------------------------------------------------

/** Pull a filename out of a Content-Disposition header (filename* preferred). */
function filenameFromDisposition(h: string | null): string | null {
  if (!h) return null;
  const star = h.match(/filename\*=UTF-8''([^;]+)/i);
  if (star && star[1]) {
    try { return decodeURIComponent(star[1]); } catch { /* fall through */ }
  }
  const plain = h.match(/filename="([^"]+)"/i);
  return plain?.[1] ?? null;
}

export async function runDownload(opts: AgentOpts & { remote: string; local?: string }): Promise<void> {
  const { base, cookie } = await setup(opts);
  const ws = await resolveWorkspace(base, cookie, opts);
  try {
    const res = await fetch(
      `${base.http}/api/sessions/${encodeURIComponent(ws.id)}/fs/download?path=${encodeURIComponent(opts.remote)}`,
      { headers: authHeaders(cookie) },
    );
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${await res.text()}`);

    const suggested = filenameFromDisposition(res.headers.get('content-disposition'))
      ?? (path.basename(opts.remote) || 'download');
    const dest = opts.local
      ? (fs.existsSync(opts.local) && fs.statSync(opts.local).isDirectory()
          ? path.join(opts.local, suggested)
          : opts.local)
      : suggested;

    if (dest === '-') {
      if (res.body) await pipeline(Readable.fromWeb(res.body as any), process.stdout);
      return;
    }
    if (!res.body) throw new Error('下载响应为空');
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
    process.stderr.write(`已保存到 ${path.resolve(dest)}\n`);
  } finally {
    await destroyWorkspace(base, cookie, ws);
  }
}
