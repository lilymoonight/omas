import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PtySession } from './session.js';
import { shellCwd } from './shell-cwd.js';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 500;

export function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

export function clampUtf8(s: string, max: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, clipped: false };
  const buf = Buffer.from(s, 'utf8').subarray(0, max);
  return { text: buf.toString('utf8') + '\n\n[... 文件过大，已截断 ...]', clipped: true };
}

export function isUnderRoot(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

export async function sessionCwd(session: PtySession): Promise<string | null> {
  return (await shellCwd(session.pid)) ?? session.cwd ?? null;
}

export function resolveUnderCwd(
  cwd: string,
  relPath: string,
): { abs: string; rel: string } | { error: 'bad_path' | 'path_escape' } {
  const trimmed = relPath.trim();
  if (trimmed.includes('\0')) return { error: 'bad_path' };
  const rel = trimmed.replace(/^\/+/, '') || '';
  const abs = rel ? path.resolve(cwd, rel) : path.resolve(cwd);
  if (!isUnderRoot(cwd, abs)) return { error: 'path_escape' };
  return { abs, rel };
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.omas.tmp.${process.pid}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

export function relFromAbs(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}
