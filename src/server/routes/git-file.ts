import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SessionHub } from '../pty/hub.js';
import type { PtySession } from '../pty/session.js';
import { shellCwd } from '../pty/shell-cwd.js';

const exec = promisify(execFile);

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  put: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

type DiffKind = 'diff' | 'untracked' | 'deleted' | 'binary' | 'content';

const writeSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(MAX_EDIT_BYTES),
});

async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

function clampUtf8(s: string, max: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, clipped: false };
  const buf = Buffer.from(s, 'utf8').subarray(0, max);
  return { text: buf.toString('utf8') + '\n\n[... 文件过大，已截断 ...]', clipped: true };
}

async function resolveRepoFile(session: PtySession, relPath: string) {
  const cwd = (await shellCwd(session.pid)) ?? session.cwd;
  const root = await gitTopLevel(cwd);
  if (!root) return { error: 'not_a_repo' as const };
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return { error: 'path_escape' as const };
  }
  return { root, abs, opts: { cwd: root, timeout: 5000, maxBuffer: MAX_EDIT_BYTES * 2 } };
}

async function readWorktreeContent(abs: string, relPath: string, opts: { cwd: string; timeout: number; maxBuffer: number }) {
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return { error: 'not_a_file' as const };
    const raw = await fsp.readFile(abs);
    if (looksBinary(raw)) {
      return { kind: 'binary' as DiffKind, binary: true, clipped: false, size: raw.length };
    }
    const { text, clipped } = clampUtf8(raw.toString('utf8'), MAX_EDIT_BYTES);
    return { kind: 'content' as DiffKind, content: text, clipped, binary: false, size: raw.length };
  } catch {
    try {
      const { stdout } = await exec('git', ['show', `HEAD:${relPath}`], opts);
      const { text, clipped } = clampUtf8(stdout, MAX_EDIT_BYTES);
      return { kind: 'content' as DiffKind, content: text, clipped, binary: false, size: stdout.length };
    } catch {
      return { error: 'file_not_found' as const };
    }
  }
}

async function writeWorktreeContent(abs: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.omas.tmp.${process.pid}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, abs);
}

export function registerGitFileRoutes(app: App, hub: SessionHub): void {
  app.get('/api/sessions/:id/git-file', async (req: any, reply: any) => {
    const { id } = req.params;
    const session = hub.get(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const relPath = String(req.query?.path ?? '').trim();
    if (!relPath || relPath.includes('\0')) return reply.code(400).send({ error: 'bad_path' });
    const staged = String(req.query?.staged ?? '') === 'true';
    const view = String(req.query?.view ?? 'diff');

    const resolved = await resolveRepoFile(session, relPath);
    if ('error' in resolved) {
      return reply.code(resolved.error === 'not_a_repo' ? 404 : 400).send({ error: resolved.error });
    }
    const { abs, opts } = resolved;

    if (view === 'content') {
      const result = await readWorktreeContent(abs, relPath, opts);
      if ('error' in result) {
        return reply.code(result.error === 'not_a_file' ? 400 : 404).send({ error: result.error });
      }
      if (result.kind === 'binary') {
        return { path: relPath, kind: 'binary' as DiffKind, binary: true, clipped: false, size: result.size };
      }
      return { path: relPath, kind: 'content' as DiffKind, content: result.content, clipped: result.clipped, binary: false, size: result.size };
    }

    try {
      const args = staged
        ? ['diff', '--cached', 'HEAD', '--', relPath]
        : ['diff', 'HEAD', '--', relPath];
      const { stdout } = await exec('git', args, opts);
      if (stdout.length > 0) {
        const { text, clipped } = clampUtf8(stdout, MAX_DIFF_BYTES);
        return { path: relPath, kind: 'diff' as DiffKind, diff: text, clipped, binary: false, size: stdout.length };
      }
    } catch {
      // first commit or other git diff failure — fall through
    }

    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return reply.code(400).send({ error: 'not_a_file' });
      const raw = await fsp.readFile(abs);
      if (looksBinary(raw)) {
        return { path: relPath, kind: 'binary' as DiffKind, binary: true, clipped: false, size: raw.length };
      }
      const { text, clipped } = clampUtf8(raw.toString('utf8'), MAX_CONTENT_BYTES);
      return { path: relPath, kind: 'untracked' as DiffKind, content: text, clipped, binary: false, size: raw.length };
    } catch {
      try {
        const { stdout } = await exec('git', ['show', `HEAD:${relPath}`], opts);
        const { text, clipped } = clampUtf8(stdout, MAX_CONTENT_BYTES);
        return { path: relPath, kind: 'deleted' as DiffKind, content: text, clipped, binary: false, size: stdout.length };
      } catch {
        return reply.code(404).send({ error: 'file_not_found' });
      }
    }
  });

  app.put('/api/sessions/:id/git-file', async (req: any, reply: any) => {
    const { id } = req.params;
    const session = hub.get(id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const relPath = parsed.data.path.trim();
    if (relPath.includes('\0')) return reply.code(400).send({ error: 'bad_path' });
    if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_EDIT_BYTES) {
      return reply.code(413).send({ error: 'too_large' });
    }
    if (looksBinary(Buffer.from(parsed.data.content, 'utf8'))) {
      return reply.code(400).send({ error: 'binary_not_allowed' });
    }

    const resolved = await resolveRepoFile(session, relPath);
    if ('error' in resolved) {
      return reply.code(resolved.error === 'not_a_repo' ? 404 : 400).send({ error: resolved.error });
    }

    try {
      await writeWorktreeContent(resolved.abs, parsed.data.content);
      const size = Buffer.byteLength(parsed.data.content, 'utf8');
      return { ok: true, path: relPath, size };
    } catch (err: any) {
      return reply.code(500).send({ error: 'write_failed', message: String(err?.message ?? err) });
    }
  });
}
