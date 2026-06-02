// Privilege-dropped filesystem worker (Model B).
//
// The server runs as root so it can launch sessions for many UNIX users; it
// therefore must NOT permanently drop privileges, and per-request euid switching
// is racy under async concurrency. So the security-sensitive filesystem syscalls
// for an OS-user session are performed in a short-lived CHILD that re-execs this
// binary, drops to the target user (initgroups → setgid → setuid), runs ONE
// operation, and exits. The kernel then enforces that user's permissions exactly.
//
// The op functions below are the single source of truth: the in-process path
// (root, no osUser) and the dropped worker call the very same code.

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_EDIT_BYTES,
  clampUtf8,
  looksBinary,
  uniqueName,
  writeBufferAtomic,
  writeFileAtomic,
} from './fs-util.js';

/** Hard cap on dirents returned over the worker boundary (route truncates further). */
const WORKER_LIST_CAP = 4000;

export type StatResult = { exists: boolean; isFile: boolean; isDir: boolean; size: number };
export type DirentLite = { name: string; isFile: boolean; isDir: boolean };
export type ReadResult = { binary: boolean; content?: string; clipped: boolean; size: number };

export async function opStat(abs: string): Promise<StatResult> {
  try {
    const st = await fsp.stat(abs);
    return { exists: true, isFile: st.isFile(), isDir: st.isDirectory(), size: st.size };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { exists: false, isFile: false, isDir: false, size: 0 };
    throw err;
  }
}

export async function opReaddir(absDir: string): Promise<{ entries: DirentLite[]; truncated: boolean }> {
  const dirents = await fsp.readdir(absDir, { withFileTypes: true });
  const out: DirentLite[] = [];
  let truncated = false;
  for (const d of dirents) {
    if (out.length >= WORKER_LIST_CAP) {
      truncated = true;
      break;
    }
    out.push({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() });
  }
  return { entries: out, truncated };
}

export async function opRead(abs: string): Promise<ReadResult> {
  const raw = await fsp.readFile(abs);
  if (looksBinary(raw)) return { binary: true, clipped: false, size: raw.length };
  const { text, clipped } = clampUtf8(raw.toString('utf8'), MAX_EDIT_BYTES);
  return { binary: false, content: text, clipped, size: raw.length };
}

export async function opWriteText(abs: string, content: string): Promise<{ size: number }> {
  await writeFileAtomic(abs, content);
  return { size: Buffer.byteLength(content, 'utf8') };
}

export async function opUpload(
  dirAbs: string,
  base: string,
  bytes: Buffer,
): Promise<{ finalAbs: string; size: number }> {
  const finalAbs = await uniqueName(dirAbs, base);
  await writeBufferAtomic(finalAbs, bytes);
  return { finalAbs, size: bytes.length };
}

// --- worker process side ---------------------------------------------------

type WorkerRequest =
  | { op: 'stat'; abs: string }
  | { op: 'readdir'; abs: string }
  | { op: 'read'; abs: string }
  | { op: 'writeText'; abs: string; content: string }
  | { op: 'upload'; dirAbs: string; base: string; bytesB64: string };

/** Drop from root to the target user. initgroups (needs root) before setgid/setuid. */
function dropPrivileges(): void {
  const uid = Number(process.env.OMAS_FS_UID);
  const gid = Number(process.env.OMAS_FS_GID);
  const user = process.env.OMAS_FS_USER ?? '';
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || !user) {
    throw new Error('fs worker: missing/invalid OMAS_FS_{UID,GID,USER}');
  }
  try {
    (process as any).initgroups?.(user, gid);
  } catch {
    try { (process as any).setgroups?.([gid]); } catch { /* best effort */ }
  }
  if (typeof process.setgid === 'function') process.setgid(gid);
  if (typeof process.setuid === 'function') process.setuid(uid);
  // Sanity: we must no longer be root.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('fs worker: failed to drop privileges (still uid 0)');
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function dispatch(req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case 'stat': return opStat(req.abs);
    case 'readdir': return opReaddir(req.abs);
    case 'read': return opRead(req.abs);
    case 'writeText': return opWriteText(req.abs, req.content);
    case 'upload': return opUpload(req.dirAbs, req.base, Buffer.from(req.bytesB64, 'base64'));
    default: throw new Error(`fs worker: unknown op`);
  }
}

/**
 * Worker entry. Invoked when OMAS_FS_WORKER=1 (gated at the top of the CLI, before
 * commander). Reads one JSON request from stdin, drops privileges, runs it, and
 * writes a single JSON response to stdout, then exits.
 */
export async function runFsWorker(): Promise<never> {
  let response: { ok: true; result: unknown } | { ok: false; code?: string; message: string };
  try {
    const reqBuf = await readStdin();
    const req = JSON.parse(reqBuf.toString('utf8')) as WorkerRequest;
    dropPrivileges();
    response = { ok: true, result: await dispatch(req) };
  } catch (err: any) {
    response = { ok: false, code: err?.code, message: String(err?.message ?? err) };
  }
  await new Promise<void>((resolve) => process.stdout.write(JSON.stringify(response), () => resolve()));
  process.exit(response.ok ? 0 : 1);
}
