// Parent side of the privilege-dropped filesystem path (Model B).
//
// For a session bound to an OS user, the security-sensitive fs syscalls are run
// in a re-exec'd worker that drops to that user (see fs-worker.ts). Sessions
// with no osUser keep running the ops in-process (root / single-user), so the
// non-multi-user code path is byte-for-byte unchanged.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  opStat,
  opReaddir,
  opRead,
  opWriteText,
  opUpload,
  type StatResult,
  type DirentLite,
  type ReadResult,
} from './fs-worker.js';
import { buildPrivilegeDrop, type OsUserInfo } from './os-user.js';

/** How to re-launch this same program as the fs worker (compiled binary or node dist). */
function reexec(): { file: string; args: string[] } {
  const entry = process.argv[1];
  // node dist: pass the entry script; Bun single-file binary: no script (it boots itself).
  const passEntry = !!entry && /\.(c|m)?[jt]s$/.test(entry) && fs.existsSync(entry);
  return { file: process.execPath, args: [...process.execArgv, ...(passEntry ? [entry] : [])] };
}

function workerEnv(info: OsUserInfo): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OMAS_FS_WORKER: '1',
    OMAS_FS_UID: String(info.uid),
    OMAS_FS_GID: String(info.gid),
    OMAS_FS_USER: info.name,
  };
}

async function runWorkerOp<T>(info: OsUserInfo, req: unknown): Promise<T> {
  const { file, args } = reexec();
  const child = spawn(file, args, { env: workerEnv(info), stdio: ['pipe', 'pipe', 'inherit'] });
  const chunks: Buffer[] = [];
  child.stdout!.on('data', (c: Buffer) => chunks.push(c));
  child.stdin!.end(JSON.stringify(req));
  const out: Buffer = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });
  let resp: any;
  try {
    resp = JSON.parse(out.toString('utf8'));
  } catch {
    throw new Error(`fs worker: bad response (${out.toString('utf8').slice(0, 200)})`);
  }
  if (!resp.ok) {
    const e: any = new Error(resp.message || 'fs worker failed');
    if (resp.code) e.code = resp.code;
    throw e;
  }
  return resp.result as T;
}

// --- structured ops: dropped via worker when osUser is set, else in-process ---

export function fsStat(osUser: OsUserInfo | null, abs: string): Promise<StatResult> {
  return osUser ? runWorkerOp<StatResult>(osUser, { op: 'stat', abs }) : opStat(abs);
}

export function fsReaddir(
  osUser: OsUserInfo | null,
  abs: string,
): Promise<{ entries: DirentLite[]; truncated: boolean }> {
  return osUser ? runWorkerOp(osUser, { op: 'readdir', abs }) : opReaddir(abs);
}

export function fsRead(osUser: OsUserInfo | null, abs: string): Promise<ReadResult> {
  return osUser ? runWorkerOp<ReadResult>(osUser, { op: 'read', abs }) : opRead(abs);
}

export function fsWriteText(
  osUser: OsUserInfo | null,
  abs: string,
  content: string,
): Promise<{ size: number }> {
  return osUser ? runWorkerOp(osUser, { op: 'writeText', abs, content }) : opWriteText(abs, content);
}

export function fsUpload(
  osUser: OsUserInfo | null,
  dirAbs: string,
  base: string,
  bytes: Buffer,
): Promise<{ finalAbs: string; size: number }> {
  return osUser
    ? runWorkerOp(osUser, { op: 'upload', dirAbs, base, bytesB64: bytes.toString('base64') })
    : opUpload(dirAbs, base, bytes);
}

// --- streaming / external tools: wrap with runuser/sudo when osUser is set ---

/** Wrap a command (cat/tar/git/…) to run as the target user, or pass through. */
export function wrapAsUser(
  osUser: OsUserInfo | null,
  file: string,
  args: string[],
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!osUser) return { file, args, env: process.env };
  const drop = buildPrivilegeDrop(process.platform, osUser, file, args);
  // runuser/sudo don't start a login shell, so set the user's identity env
  // explicitly (e.g. so `git` reads the user's ~/.gitconfig, not root's).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: osUser.home,
    USER: osUser.name,
    LOGNAME: osUser.name,
    SHELL: osUser.shell,
  };
  return { file: drop.file, args: drop.args, env };
}

/**
 * Give a file/dir to the target user. Used after a root-side write (chunked
 * upload staging) so the finished artifact is owned by the user, not root.
 * No-op without an osUser.
 */
export async function chownToUser(osUser: OsUserInfo | null, abs: string): Promise<void> {
  if (!osUser) return;
  await fsp.chown(abs, osUser.uid, osUser.gid);
}

/** Spawn a privilege-aware child for streaming reads (download). */
export function spawnAsUser(
  osUser: OsUserInfo | null,
  file: string,
  args: string[],
  opts: { stdio?: any } = {},
): ChildProcess {
  const w = wrapAsUser(osUser, file, args);
  return spawn(w.file, w.args, { stdio: opts.stdio ?? ['ignore', 'pipe', 'ignore'], env: w.env });
}
